// pm2 process for the WBTC carry bot (deployed to /home/kdn/wbtc by scripts/deploy-wbtc.sh).
module.exports = {
  apps: [
    {
      name: "kdn-wbtc",
      cwd: __dirname,
      script: "apps/wbtc/src/cli.ts",
      args: "watch",
      interpreter: "node",
      // A smaller heap makes V8 collect sooner; the tracker needs little.
      node_args: "--import tsx --disable-warning=ExperimentalWarning --max-old-space-size=128",
      exp_backoff_restart_delay: 5_000,
      // Third process on a 1 GB droplet: the ETH bots have priority.
      max_memory_restart: "250M",
      time: true,
      env: { NODE_ENV: "production" },
    },
  ],
};
