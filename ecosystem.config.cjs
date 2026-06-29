module.exports = {
  apps: [
    {
      name: "mixforge",
      script: "src/server.js",
      interpreter: "node",
      node_args: "--experimental-vm-modules",
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "512M",
      env_production: {
        NODE_ENV: "production",
        HOST: "127.0.0.1",
        PORT: "4173"
      }
    }
  ]
};
