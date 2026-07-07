// pm2 alternative to Docker Compose (bare-metal VPS):
//   npm ci && npm run build && pm2 start ecosystem.config.cjs && pm2 save
module.exports = {
  apps: [
    {
      name: "brightos-app",
      script: "node_modules/.bin/next",
      args: "start -p 3100",
      env: { NODE_ENV: "production" },
      max_memory_restart: "512M",
    },
    {
      name: "brightos-workers",
      script: "node_modules/.bin/tsx",
      args: "src/workers/index.ts",
      max_memory_restart: "384M",
    },
    {
      name: "brightos-watcher",
      script: "node_modules/.bin/tsx",
      args: "src/watcher/index.ts",
      max_memory_restart: "256M",
    },
  ],
};
