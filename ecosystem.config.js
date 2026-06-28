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
      restart_delay: 5000,      // wait 5s before restart on crash
      max_restarts:  10,        // give up after 10 crashes in a row
      env: {
        NODE_ENV: 'production'
      }
    }
  ]
};
