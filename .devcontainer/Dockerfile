# Dev Container image used by .devcontainer/devcontainer.json.
#
# The base image is the official JavaScript/Node 24 devcontainer image. It
# already includes git, sudo and the tooling the IDE server expects, which the
# slim production image intentionally leaves out.
FROM mcr.microsoft.com/devcontainers/javascript-node:24-bookworm

WORKDIR /workspaces/web-calendar

# Install dependencies during the image build. The named node_modules volume is
# seeded from this directory on first start, so the container works even in
# IDEs that do not execute postCreateCommand.
COPY package.json package-lock.json ./
RUN npm ci

# Ensure the container user owns the workspace and the dependency directory.
RUN chown -R node:node /workspaces/web-calendar
