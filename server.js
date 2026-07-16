const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

// Simple .env loader
function loadEnv() {
  const envFiles = [path.join(__dirname, '.env'), path.join(__dirname, 'key.env')];
  envFiles.forEach(envPath => {
    if (fs.existsSync(envPath)) {
      const envContent = fs.readFileSync(envPath, 'utf8');
      envContent.split('\n').forEach(line => {
        const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
        if (match) {
          const key = match[1];
          let value = match[2] || '';
          if (value.length > 0 && value.charAt(0) === '"' && value.charAt(value.length - 1) === '"') {
            value = value.substring(1, value.length - 1);
          }
          if (value.length > 0 && value.charAt(0) === "'" && value.charAt(value.length - 1) === "'") {
            value = value.substring(1, value.length - 1);
          }
          process.env[key] = value.trim();
        }
      });
    }
  });
}

loadEnv();

const PORT = process.env.PORT || 3000;
let apiKey = process.env.VITE_GEMINI_API_KEY || '';
const defaultModel = 'gemini-flash-latest';

// Proxy function to forward requests to Gemini API directly as-is
function proxyToGemini(modelName, reqBody, res, keyToUse) {
  const postData = JSON.stringify(reqBody);
  const targetModel = modelName || defaultModel;
  const targetKey = keyToUse || apiKey;

  if (!targetKey) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'No API key configured on server. Please use Mock Mode or enter a key.' } }));
    return;
  }

  function makeRequest(attemptModel) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${attemptModel}:generateContent?key=${targetKey}`;
    const options = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    console.log(`[Proxy] Forwarding request to Gemini API. Model: ${attemptModel}`);

    const proxyReq = https.request(url, options, (proxyRes) => {
      let responseBody = '';
      
      proxyRes.on('data', (chunk) => {
        responseBody += chunk;
      });

      proxyRes.on('end', () => {
        // If the model fails with 404 and was gemini-flash-latest, fallback to gemini-3-flash
        if (proxyRes.statusCode === 404 && attemptModel === 'gemini-flash-latest') {
          console.warn(`\x1b[33m[Proxy Fallback] gemini-flash-latest returned 404. Retrying with gemini-3-flash...\x1b[0m`);
          makeRequest('gemini-3-flash');
          return;
        }

        if (proxyRes.statusCode !== 200) {
          console.error(`\x1b[31m[Gemini Error Response] HTTP ${proxyRes.statusCode} for ${attemptModel}:\x1b[0m`, responseBody);
        } else {
          console.log(`\x1b[32m[Proxy Success] HTTP 200 OK from Gemini API using ${attemptModel}.\x1b[0m`);
        }

        res.writeHead(proxyRes.statusCode, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': '*'
        });
        res.end(responseBody);
      });
    });

    proxyReq.on('error', (err) => {
      console.error(`[Proxy Connection Error]`, err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `Proxy connection error: ${err.message}` } }));
    });

    proxyReq.write(postData);
    proxyReq.end();
  }

  makeRequest(targetModel);
}

// Create HTTP server
const server = http.createServer((req, res) => {
  // Add CORS headers for developer convenience
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key, x-model-name');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // API Route: Config info
  if (req.url === '/api/config' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      defaultModel: defaultModel,
      isKeyConfigured: !!apiKey,
      apiKeyMasked: apiKey ? `${apiKey.substring(0, 5)}...${apiKey.substring(apiKey.length - 4)}` : ''
    }));
    return;
  }

  // API Route: Gemini Proxy
  if (req.url.startsWith('/api/gemini') && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body);
        const reqModel = req.headers['x-model-name'] || parsed.model || defaultModel;
        const reqKey = req.headers['x-api-key'] || apiKey;
        
        proxyToGemini(reqModel, parsed.body || parsed, res, reqKey);
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Invalid JSON request body' } }));
      }
    });
    return;
  }

  // Serve static files
  let filePath = path.join(__dirname, req.url === '/' ? 'index.html' : req.url);
  // Prevent directory traversal
  if (!filePath.startsWith(__dirname)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }

  const extname = String(path.extname(filePath)).toLowerCase();
  const mimeTypes = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml'
  };

  const contentType = mimeTypes[extname] || 'application/octet-stream';

  fs.readFile(filePath, (error, content) => {
    if (error) {
      if (error.code === 'ENOENT') {
        // Fallback to index.html for SPA routing if requested file doesn't exist
        fs.readFile(path.join(__dirname, 'index.html'), (err, htmlContent) => {
          if (err) {
            res.writeHead(500);
            res.end('Server Error: File not found');
          } else {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(htmlContent, 'utf-8');
          }
        });
      } else {
        res.writeHead(500);
        res.end(`Server Error: ${error.code}`);
      }
    } else {
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content, 'utf-8');
    }
  });
});

server.listen(PORT, () => {
  console.log(`\n🚀 LearnLoop server running at http://localhost:${PORT}`);
  console.log(`🔗 Dev API Proxy endpoint: http://localhost:${PORT}/api/gemini`);
  console.log(`💡 Standby for demo verification...\n`);
});
