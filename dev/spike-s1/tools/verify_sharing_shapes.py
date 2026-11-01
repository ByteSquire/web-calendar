#!/usr/bin/env python3
"""Checks the Radicale 3.9 sharing API shapes the sharing writer relies on (test stack only).

Uses only users/collections named p3v-* (and the service principals `_resources` / `_p3v-team`, whose
only collection is deleted again). Everything created is deleted at the end, also after a failure.
Exit code 0 when every check agrees with the shapes in docs/design.md §11 (the table it was
written against is in git history: git show 352d101:docs/phase3-notes/sharing-verify.md).
Not covered: group MEMBERSHIP (needs a line in the stack's htgroup file, which this script never edits).
"""
import json
import sys

from s5_shares import api, delete, hrefs, mkcal, propfind, put_event, req, accept

OWN, MEM, TEAM, RES = "p3v-own", "p3v-mem", "_p3v-team", "_resources"
failures = []


def check(name, ok, detail=""):
    print("%s %s %s" % ("ok  " if ok else "FAIL", name, detail if not ok else ""))
    if not ok:
        failures.append(name)


def shares(owner, shtype="map"):
    s, d, _ = api(owner, shtype, "list", {})
    return s, (json.loads(d).get("Content") if s == 200 else None)


def create(owner, mapped, target, user, perms):
    return api(owner, "map", "create", {"PathMapped": mapped, "PathOrToken": target, "User": user,
                                        "Permissions": perms, "Enabled": True, "Hidden": False})[0]


def cleanup():
    for owner in (OWN, TEAM, RES):
        s, content = shares(owner)
        for row in content or []:
            if row["PathOrToken"] and (row["PathMapped"].startswith(("/p3v-", "/_p3v-")) or
                                       row["PathOrToken"].startswith("/{user}/p3v-") or
                                       row["PathOrToken"] == "/{user}/p3v-resource-availability/"):
                api(owner, "map", "delete", {"PathOrToken": row["PathOrToken"]})
    delete(OWN, "/p3v-own/cal/")
    delete(TEAM, "/_p3v-team/main/")
    delete(RES, "/_resources/p3v-availability/")
    for user in (OWN, MEM, TEAM, "p3v-fresh"):
        delete(user, "/%s/" % user)


def run():
    mkcal(OWN, "cal")
    req(MEM, "PROPFIND", "/p3v-mem/", None, {"Depth": "0"})
    put_event(OWN, "cal", "p3v-ev")

    # (1) user share: list shape, flags, group share form
    check("user create", create(OWN, "/p3v-own/cal/", "/p3v-mem/shared-7/", MEM, "r") == 200)
    s, rows = shares(OWN)
    row = rows[0] if rows else {}
    check("list has the four flags, not Enabled/Hidden",
          all(k in row for k in ("EnabledByOwner", "EnabledByUser", "HiddenByOwner", "HiddenByUser"))
          and "Enabled" not in row and "Hidden" not in row, str(row))
    check("new user share is off and hidden for the member",
          row.get("EnabledByUser") is False and row.get("HiddenByUser") is True, str(row))
    check("PathOrToken is the owner's chosen name", row.get("PathOrToken") == "/p3v-mem/shared-7/")
    check("member not yet served", req(MEM, "PROPFIND", "/p3v-mem/shared-7/", None, {"Depth": "0"})[0] == 404)
    a, b, _ = accept(MEM, "/p3v-mem/shared-7/")
    check("enable+unhide as member", (a, b) == (200, 200))
    s, d, _ = propfind(MEM, "/p3v-mem/", 1, "<D:displayname/><D:resourcetype/>")
    check("member home lists the mapped name", "/p3v-mem/shared-7/" in hrefs(d))
    check("mapped calendar carries the owner's displayname", "<displayname>cal</displayname>" in d)
    check("owner enable leaves the member flag alone", api(OWN, "map", "enable",
          {"PathOrToken": "/p3v-mem/shared-7/"})[0] == 200 and
          shares(OWN)[1][0]["EnabledByUser"] is True)
    check("second share same source+user: 409", create(OWN, "/p3v-own/cal/", "/p3v-mem/shared-8/", MEM, "r") == 409)
    check("same path, other permission: 409", create(OWN, "/p3v-own/cal/", "/p3v-mem/shared-7/", MEM, "rw") == 409)
    check("group create ok", create(OWN, "/p3v-own/cal/", "/{user}/shared-7-p3v-g/", ":p3v-g", "r") == 200)
    check("group without placeholder: 403", create(OWN, "/p3v-own/cal/", "/p3v-mem/x/", ":p3v-h", "r") == 403)
    s, rows = shares(OWN)
    g = [r for r in rows if r["User"].startswith(":")]
    check("group row: User ':group', {user} kept, epu appended, flags on",
          len(g) == 1 and g[0]["PathOrToken"] == "/{user}/shared-7-p3v-g/" and g[0]["User"] == ":p3v-g"
          and sorted(g[0]["Permissions"]) == sorted("eupr") and g[0]["EnabledByUser"] is True
          and g[0]["HiddenByUser"] is False, str(g))
    check("member's own list excludes the owner's group row (no membership)",
          all(not r["User"].startswith(":") for r in shares(MEM)[1]))
    check("empty list is 200 with Content []", shares("p3v-nobody") == (200, []))

    # (2) tokens
    check("token/list is 404 (collection_by_token off)", api(OWN, "token", "list", {})[0] == 404)
    check("token/delete is 404", api(OWN, "token", "delete", {"PathOrToken": "/.token/x/"})[0] == 404)

    # delete
    check("member cannot delete", api(MEM, "map", "delete", {"PathOrToken": "/p3v-mem/shared-7/"})[0] == 403)
    check("owner deletes the group row",
          api(OWN, "map", "delete", {"PathOrToken": "/{user}/shared-7-p3v-g/"})[0] == 200)
    check("delete of a missing share: 404", api(OWN, "map", "delete", {"PathOrToken": "/p3v-mem/nope/"})[0] == 404)

    # (4) enable on a missing share
    check("enable of a missing share: 404", api(MEM, "map", "enable", {"PathOrToken": "/p3v-mem/nope/"})[0] == 404)

    # (5) _resources and shared owner principals
    check("fresh home is created by PROPFIND", req("p3v-fresh", "PROPFIND", "/p3v-fresh/", None, {"Depth": "1"})[0] == 207)
    req(RES, "PROPFIND", "/_resources/", None, {"Depth": "0"})
    check("MKCALENDAR as _resources", req(RES, "MKCALENDAR", "/_resources/p3v-availability/")[0] in (201, 409))
    check("MKCALENDAR of an existing collection: 409", req(RES, "MKCALENDAR", "/_resources/p3v-availability/")[0] == 409)
    check("f to a group from _resources", create(RES, "/_resources/p3v-availability/",
          "/{user}/p3v-resource-availability/", ":p3v-g", "f") == 200)
    s, rows = shares(RES)
    check("_resources list: epuf", [r for r in rows if r["PathMapped"] == "/_resources/p3v-availability/"][0]["Permissions"].count("") > 0
          and sorted([r for r in rows if r["PathMapped"] == "/_resources/p3v-availability/"][0]["Permissions"]) == sorted("epuf"))
    mkcal(TEAM, "main")
    check("shared owner home lists its calendar", "/_p3v-team/main/" in hrefs(propfind(TEAM, "/_p3v-team/", 1)[1]))
    check("team calendar shared rw", create(TEAM, "/_p3v-team/main/", "/p3v-mem/shared-9/", MEM, "rw") == 200)
    accept(MEM, "/p3v-mem/shared-9/")
    check("member writes into the team calendar",
          req(MEM, "PUT", "/p3v-mem/shared-9/p3v-x.ics", open_ics("p3v-x"), {"Content-Type": "text/calendar"})[0] == 201)


def open_ics(uid):
    from s5_shares import ICS
    return ICS % uid


if __name__ == "__main__":
    cleanup()
    try:
        run()
    finally:
        cleanup()
        left = [(o, len(shares(o)[1] or [])) for o in (OWN, TEAM, RES)]
        print("shares left:", left)
    print("FAILED: %s" % failures if failures else "all checks agree")
    sys.exit(1 if failures else 0)
