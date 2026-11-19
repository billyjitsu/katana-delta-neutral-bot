// pm2 process definition for the droplet: `pm2 startOrReload ecosystem.config.cjs`.
module.exports = {
  apps: [
    {
      name: "kdn-watch",
      cwd: __dirname,
      script: "apps/bot/src/cli.ts",
      args: "watch",
      interpreter: "node",
      node_args: "--import tsx --disable-warning=ExperimentalWarning",
      // Crash-loop protection: wait longer between each consecutive restart.
      exp_backoff_restart_delay: 5_000,
      // The droplet has ~450 MB RAM; restart before the bot can starve other apps.
      max_memory_restart: "250M",
      time: true,
      env: { NODE_ENV: "production" },
    },
  ],
};
