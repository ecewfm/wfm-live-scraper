// ecosystem.config.js — pm2 process manager config
//
// Install pm2 once:  npm install -g pm2
// Start:             pm2 start ecosystem.config.js
// Stop:              pm2 stop aircall-scraper
// Logs:              pm2 logs aircall-scraper
// Auto-start on boot: pm2 startup  (then run the command it prints)

module.exports = {
  apps: [
    {
      name:         'wfm-live-scraper',
      script:       'scraper.js',
      watch:        false,
      autorestart:  true,       // always bring it back
      restart_delay: 5000,      // wait 5s before restart on crash
      max_restarts:  500,       // high cap for long unattended 24/7 runs
      env: {
        NODE_ENV: 'production',
        HEADLESS: 'true'        // MUST be headless under a Windows Service (no desktop)
      }
    }
  ]
};
