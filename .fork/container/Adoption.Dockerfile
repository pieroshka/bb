FROM bb-fork-ci
USER root
RUN npm install --prefix /legacy --omit=dev bb-app@0.44.0
USER node
ENV BB_FORK_LEGACY_COMMAND=/usr/local/bin/node BB_FORK_LEGACY_ENTRY=/legacy/node_modules/bb-app/dist/bb-app.js
ENTRYPOINT ["node", ".fork/adoption.smoke.mjs"]
