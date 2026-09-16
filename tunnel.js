require('dotenv').config();
const localtunnel = require('localtunnel');

(async () => {
  try {
    console.log('🚀 Starting tunnel on port 3000...');
    const tunnel = await localtunnel({ port: 3000 });

    console.log('✅ Tunnel is live!');
    console.log('📡 Public URL:', tunnel.url);
    console.log('\nVisit that URL in a browser first and click "Click to Continue"');
    console.log('Press Ctrl+C to stop the tunnel.\n');

    tunnel.on('close', () => {
      console.log('🔴 Tunnel closed.');
    });

    tunnel.on('error', (err) => {
      console.error('❌ Tunnel error:', err.message);
    });
  } catch (err) {
    console.error('❌ Failed to start tunnel:', err.message || err);
    process.exit(1);
  }
})();
