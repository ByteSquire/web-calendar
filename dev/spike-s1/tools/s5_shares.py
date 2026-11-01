#!/usr/bin/env python3
"""S5 measurements against the spike Radicale (standard library only; test stack only).

  perms   what a map share with each permission string gives the member (f, r, rw, ...)
  scale   N map shares: create time, list time, sharing.csv size, member-home PROPFIND, full
          list-and-compare, Radicale CPU and memory (via `docker stats`)
  clean   delete every share and collection of the s5- users

Only users and collections named s5-* are touched. Radicale trusts X-Remote-User here.
Usage: s5_shares.py perms | scale N [--runs 3] | clean
"""
import argparse
import http.client
import json
import re
import statistics
import subprocess
import sys
import time

HOST, PORT = "127.0.0.1", 5232
CONTAINER = "spike-s1-radicale-1"
CSV = "/var/lib/radicale/sharing.csv"
ICS = ("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//s5//EN\r\nBEGIN:VEVENT\r\nUID:%s\r\n"
       "DTSTAMP:20261101T000000Z\r\nDTSTART:20261110T100000Z\r\nDTEND:20261110T110000Z\r\n"
       "SUMMARY:SECRET-TITLE\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n")


def req(user, method, path, body=None, headers=None, conn=None):
    c = conn or http.client.HTTPConnection(HOST, PORT, timeout=300)
    h = {"X-Remote-User": user}
    h.update(headers or {})
    t = time.perf_counter()
    c.request(method, path, body=body, headers=h)
    r = c.getresponse()
    data = r.read().decode("utf-8", "replace")
    dt = time.perf_counter() - t
    if conn is None:
        c.close()
    return r.status, data, dt


def api(owner, shtype, action, payload, conn=None):
    s, d, dt = req(owner, "POST", "/.sharing/v1/%s/%s" % (shtype, action), json.dumps(payload),
                   {"Content-Type": "application/json", "Accept": "application/json"}, conn)
    return s, d, dt


def accept(member, tgt, conn=None):
    """A user share is only live after the member enables and unhides it (group shares need neither)."""
    a = api(member, "map", "enable", {"PathOrToken": tgt}, conn)
    b = api(member, "map", "unhide", {"PathOrToken": tgt}, conn)
    return a[0], b[0], a[2] + b[2]


def mkcal(user, name):
    req(user, "PROPFIND", "/%s/" % user, None, {"Depth": "0"})  # first access creates the home
    body = ('<?xml version="1.0"?><C:mkcalendar xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">'
            "<D:set><D:prop><D:displayname>%s</D:displayname>"
            "<C:supported-calendar-component-set><C:comp name=\"VEVENT\"/></C:supported-calendar-component-set>"
            "</D:prop></D:set></C:mkcalendar>" % name)
    return req(user, "MKCALENDAR", "/%s/%s/" % (user, name), body)[0]


def put_event(user, cal, uid):
    return req(user, "PUT", "/%s/%s/%s.ics" % (user, cal, uid), ICS % uid,
               {"Content-Type": "text/calendar"})[0]


def delete(user, path):
    return req(user, "DELETE", path)[0]


def propfind(user, path, depth, props="<D:displayname/><D:resourcetype/><D:current-user-privilege-set/>"):
    body = '<?xml version="1.0"?><D:propfind xmlns:D="DAV:"><D:prop>%s</D:prop></D:propfind>' % props
    return req(user, "PROPFIND", path, body, {"Depth": str(depth), "Content-Type": "application/xml"})


def hrefs(xml):
    return re.findall(r"<(?:\w+:)?href>([^<]*)</", xml)


def csv_size():
    out = subprocess.run(["docker", "exec", CONTAINER, "sh", "-c", "wc -c < %s; wc -l < %s" % (CSV, CSV)],
                         capture_output=True, text=True).stdout.split()
    return int(out[0]), int(out[1])


def stats():
    out = subprocess.run(["docker", "stats", "--no-stream", "--format", "{{.CPUPerc}} {{.MemUsage}}", CONTAINER],
                         capture_output=True, text=True).stdout.strip()
    return out


def summary(label, xs):
    return "%s: median %.1f ms, worst %.1f ms (n=%d)" % (label, statistics.median(xs) * 1000, max(xs) * 1000, len(xs))


REPORT_CQ = ('<?xml version="1.0"?><C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">'
             "<D:prop><D:getetag/><C:calendar-data/></D:prop><C:filter><C:comp-filter name=\"VCALENDAR\">"
             "<C:comp-filter name=\"VEVENT\"/></C:comp-filter></C:filter></C:calendar-query>")
REPORT_FB = ('<?xml version="1.0"?><C:free-busy-query xmlns:C="urn:ietf:params:xml:ns:caldav">'
             '<C:time-range start="20261101T000000Z" end="20261201T000000Z"/></C:free-busy-query>')


def perms(args):
    owner, member = "s5-own", "s5-mem"
    mkcal(owner, "cal")
    req(member, "PROPFIND", "/%s/" % member, None, {"Depth": "0"})
    put_event(owner, "cal", "s5-ev1")
    put_event(owner, "cal", "s5-ev2")
    perm_list = args.perms.split(",")
    for perm in perm_list:
        for kind, mapped in (("collection", "/%s/cal/" % owner), ("item", "/%s/cal/s5-ev1.ics" % owner),
                             ("home", "/%s/" % owner)):
            tgt = "/%s/shared-%s-%s/" % (member, kind, perm) if kind != "item" else \
                "/%s/shared-item-%s.ics" % (member, perm)
            s, d, _ = api(owner, "map", "create", {"PathMapped": mapped, "PathOrToken": tgt, "User": member,
                                                   "Permissions": perm, "Enabled": True, "Hidden": False})
            print("== perm=%r kind=%s create -> %s %s" % (perm, kind, s, d[:100].replace("\n", " ")))
            if s != 200:
                continue
            ls = api(owner, "map", "list", {})
            row = [r for r in json.loads(ls[1]).get("Content", []) if r.get("PathOrToken") == tgt]
            print("   list returns Permissions=%r" % (row[0]["Permissions"] if row else None))
            print("   member accept (enable, unhide) -> %s %s" % accept(member, tgt)[:2])
            if kind == "collection":
                st, d, _ = propfind(member, "/%s/" % member, 1)
                print("   PROPFIND home D1 hrefs:", [h for h in hrefs(d) if "shared" in h])
                st, d, _ = propfind(member, tgt, 0, "<D:displayname/><D:resourcetype/><D:current-user-privilege-set/>"
                                    "<C:supported-calendar-component-set xmlns:C=\"urn:ietf:params:xml:ns:caldav\"/>")
                priv = re.findall(r"<(?:\w+:)?privilege>\s*<(?:\w+:)?([\w-]+)", d)
                print("   PROPFIND cal D0 -> %s, privileges %s, displayname %s" % (st, sorted(set(priv)),
                      "yes" if "displayname" in d and "<ns0:displayname>" in d or "displayname>" in d else "?"))
                st, d, _ = propfind(member, tgt, 1)
                print("   PROPFIND cal D1 -> %s, event hrefs %d" % (st, len([h for h in hrefs(d) if h.endswith(".ics")])))
                st, d, _ = req(member, "GET", tgt + "s5-ev1.ics")
                print("   GET event -> %s, body leaks title: %s" % (st, "SECRET-TITLE" in d))
                st, d, _ = req(member, "GET", tgt)
                print("   GET collection -> %s, leaks: %s" % (st, "SECRET-TITLE" in d))
                st, d, _ = req(member, "REPORT", tgt, REPORT_CQ, {"Depth": "1", "Content-Type": "application/xml"})
                print("   REPORT calendar-query -> %s, events %d, leaks %s" % (st, d.count("VEVENT") // 2, "SECRET-TITLE" in d))
                st, d, _ = req(member, "REPORT", tgt, REPORT_FB, {"Depth": "1", "Content-Type": "application/xml"})
                print("   REPORT free-busy-query -> %s, VFREEBUSY %s, FREEBUSY lines %d, leaks %s" % (
                    st, "VFREEBUSY" in d, d.count("FREEBUSY;") + d.count("FREEBUSY:"), "SECRET-TITLE" in d))
                st, d, _ = req(member, "PUT", tgt + "s5-w.ics", ICS % "s5-w", {"Content-Type": "text/calendar"})
                print("   PUT new event -> %s" % st)
                st, d, _ = req(member, "PUT", tgt + "s5-ev2.ics", (ICS % "s5-ev2").replace("SECRET-TITLE", "CHANGED"),
                               {"Content-Type": "text/calendar"})
                print("   PUT overwrite event -> %s" % st)
                st, d, _ = req(member, "DELETE", tgt + "s5-w.ics")
                print("   DELETE new event -> %s" % st)
            elif kind == "item":
                st, d, _ = req(member, "GET", tgt)
                print("   GET single item share -> %s leaks %s" % (st, "SECRET-TITLE" in d))
                st, d, _ = propfind(member, "/%s/" % member, 1)
                print("   home D1 lists item share:", any("shared-item" in h for h in hrefs(d)))
            else:
                st, d, _ = propfind(member, tgt, 1)
                print("   PROPFIND home-share D1 -> %s hrefs %s" % (st, hrefs(d)))
            api(owner, "map", "delete", {"PathMapped": mapped, "PathOrToken": tgt, "User": member})
    # invalid strings
    for perm in ("x", "rf", "fr", "F", "", "rwf"):
        s, d, _ = api(owner, "map", "create", {"PathMapped": "/%s/cal/" % owner, "PathOrToken": "/%s/t/" % member,
                                               "User": member, "Permissions": perm, "Enabled": True, "Hidden": False})
        print("== create Permissions=%r -> %s %s" % (perm, s, d[:80].replace("\n", " ")))
        if s == 200:
            ls = api(owner, "map", "list", {})
            print("   stored:", [r["Permissions"] for r in json.loads(ls[1])["Content"] if r["PathOrToken"] == "/%s/t/" % member])
            api(owner, "map", "delete", {"PathMapped": "/%s/cal/" % owner, "PathOrToken": "/%s/t/" % member, "User": member})


def scale(args):
    """N shares = members x per, where per = N // members distinct source calendars: Radicale allows one
    map share per (source collection, user), so a member with K shares needs K distinct calendars."""
    members = ["s5-m%d" % i for i in range(args.members)]
    per = max(1, args.n // len(members))
    n = per * len(members)
    owners = ["s5-o%d" % i for i in range(args.owners)]
    cals = []
    for i in range(per):
        o = owners[i % len(owners)]
        name = "c%d" % i
        mkcal(o, name)
        put_event(o, name, "s5-ev")
        cals.append((o, name))
    base = csv_size()
    print("N=%d shares: %d members x %d calendars (%d owners); csv before: %s bytes/%s lines; radicale %s"
          % (n, len(members), per, len(owners), base[0], base[1], stats()))
    conns = {o: http.client.HTTPConnection(HOST, PORT, timeout=300) for o in owners}
    created, times, acc = [], [], []
    mconns = {m: http.client.HTTPConnection(HOST, PORT, timeout=300) for m in members}
    for m in members:
        req(m, "PROPFIND", "/%s/" % m, None, {"Depth": "0"})
    for i in range(n):
        o, name = cals[i // len(members)]
        m = members[i % len(members)]
        tgt = "/%s/s5-%s-%s/" % (m, o, name)
        s, d, dt = api(o, "map", "create", {"PathMapped": "/%s/%s/" % (o, name), "PathOrToken": tgt, "User": m,
                                            "Permissions": "r", "Enabled": True, "Hidden": False}, conns[o])
        if s != 200:
            print("create failed", i, s, d[:100])
            break
        created.append((o, m, tgt))
        times.append(dt)
        acc.append(accept(m, tgt, mconns[m])[2])
    q = len(times) // 4 or 1
    print("create: total %.2f s; per-call median %.1f ms; first quarter median %.1f ms; last quarter median %.1f ms; worst %.1f ms"
          % (sum(times), statistics.median(times) * 1000, statistics.median(times[:q]) * 1000,
             statistics.median(times[-q:]) * 1000, max(times) * 1000))
    print("sharing.csv now: %s bytes / %s lines (delta %d bytes over %d shares); radicale %s"
          % (*csv_size(), csv_size()[0] - base[0], len(created), stats()))
    print("member accept (enable+unhide) per share: median %.1f ms, worst %.1f ms" % (statistics.median(acc) * 1000, max(acc) * 1000))
    # list
    lt, rows = [], 0
    for _ in range(args.runs):
        s, d, dt = api(owners[0], "map", "list", {})
        lt.append(dt)
        rows = len(json.loads(d).get("Content", []))
    print("list as one owner (%d rows, %d bytes): %s" % (rows, len(d), summary("list", lt)))
    ct = []
    for _ in range(args.runs):
        t = time.perf_counter()
        total = 0
        for o in owners:
            s, d, _ = api(o, "map", "list", {})
            total += len(json.loads(d).get("Content", []))
        ct.append(time.perf_counter() - t)
    desired = {(o, m, t) for o, m, t in created}
    t = time.perf_counter()
    actual = set()
    for o in owners:
        for r in json.loads(api(o, "map", "list", {})[1]).get("Content", []):
            actual.add((o, r["User"], r["PathOrToken"]))
    diff = desired ^ actual
    ct.append(time.perf_counter() - t)
    print("%s (full list of all owners = %d rows, compare diff=%d)" % (summary("full list-and-compare", ct), total, len(diff)))
    # member home
    by_member = {}
    for o, m, t in created:
        by_member.setdefault(m, []).append(t)
    for m, ts in sorted(by_member.items(), key=lambda kv: len(kv[1])):
        pass
    for m in sorted(by_member, key=lambda k: len(by_member[k]))[:1] + sorted(by_member, key=lambda k: len(by_member[k]))[-1:]:
        pt = []
        for _ in range(args.runs):
            s, d, dt = propfind(m, "/%s/" % m, 1)
            pt.append(dt)
        print("PROPFIND home D1 as %s with %d shares: status %s, %d hrefs, %d bytes, %s"
              % (m, len(by_member[m]), s, len(hrefs(d)), len(d), summary("propfind", pt)))
        gt = []
        for _ in range(args.runs):
            s, d, dt = req(m, "GET", by_member[m][0] + "s5-ev.ics")
            gt.append(dt)
        print("   GET one event through a share (resolver lookup) as %s: %s status %s" % (m, summary("GET", gt), s))
    print("radicale after: %s" % stats())
    if args.keep:
        return
    clean(args)


def clean(args):
    n = 0
    for i in range(args.owners if hasattr(args, "owners") else 8):
        pass
    owners = set()
    for line in subprocess.run(["docker", "exec", CONTAINER, "sh", "-c", "cut -d';' -f5 %s" % CSV],
                               capture_output=True, text=True).stdout.split():
        if line.startswith("s5-"):
            owners.add(line)
    for o in sorted(owners):
        s, d, _ = api(o, "map", "list", {})
        rows = json.loads(d).get("Content", [])
        c = http.client.HTTPConnection(HOST, PORT, timeout=300)
        for r in rows:
            api(o, "map", "delete", {"PathMapped": r["PathMapped"], "PathOrToken": r["PathOrToken"], "User": r["User"]}, c)
            n += 1
    print("deleted %d shares" % n)
    out = subprocess.run(["docker", "exec", CONTAINER, "sh", "-c", "ls -d /var/lib/radicale/collections/collection-root/s5-* 2>/dev/null"],
                         capture_output=True, text=True).stdout.split()
    for p in out:
        u = p.rsplit("/", 1)[1]
        print("delete home", u, delete(u, "/%s/" % u))
    print("csv:", csv_size(), "s5 rows left:", subprocess.run(["docker", "exec", CONTAINER, "sh", "-c", "grep -c ';s5-' %s" % CSV], capture_output=True, text=True).stdout.strip())


def main():
    p = argparse.ArgumentParser()
    sp = p.add_subparsers(dest="cmd", required=True)
    a = sp.add_parser("perms")
    a.add_argument("--perms", default="f,r,rw,fr,rf")
    b = sp.add_parser("scale")
    b.add_argument("n", type=int)
    b.add_argument("--owners", type=int, default=4)
    b.add_argument("--members", type=int, default=20)
    b.add_argument("--runs", type=int, default=5)
    b.add_argument("--keep", action="store_true")
    sp.add_parser("clean")
    args = p.parse_args()
    {"perms": perms, "scale": scale, "clean": clean}[args.cmd](args)


if __name__ == "__main__":
    sys.exit(main())
