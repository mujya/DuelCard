FROM node:24-bookworm-slim

WORKDIR /duelyst
# bcrypt has no Node 24 prebuilt binary; allow its install script to run and
# keep a toolchain available for the node-gyp fallback.
RUN apt update && apt -y install python3 make gcc g++
COPY package.json /duelyst/
COPY .yarnrc.yml /duelyst/
COPY yarn.lock /duelyst/
COPY packages /duelyst/packages
RUN corepack enable
RUN corepack yarn set version berry
RUN corepack yarn workspaces focus -A --production && corepack yarn cache clean

COPY version.json /duelyst/
COPY app/*.coffee /duelyst/app/
COPY app/common /duelyst/app/common
COPY app/data /duelyst/app/data
COPY app/localization /duelyst/app/localization
COPY app/sdk /duelyst/app/sdk
COPY bin /duelyst/bin
COPY config /duelyst/config
COPY server /duelyst/server
COPY worker /duelyst/worker

EXPOSE 8000
ENTRYPOINT ["yarn", "sp"]
