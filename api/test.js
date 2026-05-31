const http = require('http');

const PORT = process.env.PORT || 3000;
const HOST = 'localhost';

function testEndpoint(path) {
  return new Promise((resolve, reject) => {
    http.get(`http://${HOST}:${PORT}${path}`, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`Failed ${path}: Status ${res.statusCode}`));
        } else {
          try {
            const parsed = JSON.parse(data);
            console.log(`[PASS] ${path} returned valid JSON. Object keys:`, Object.keys(parsed));
            resolve(parsed);
          } catch (e) {
            reject(new Error(`Failed ${path}: Invalid JSON output`));
          }
        }
      });
    }).on('error', (err) => reject(err));
  });
}

async function runTests() {
  console.log("=== RUNNING API INTEGRATION TESTS ===");
  try {
    const metrics = await testEndpoint('/api/metrics');
    if (typeof metrics.footfall !== 'number') throw new Error("metrics.footfall is not a number");
    if (typeof metrics.avgDwellMinutes !== 'number') throw new Error("metrics.avgDwellMinutes is not a number");
    if (typeof metrics.conversionRate !== 'number') throw new Error("metrics.conversionRate is not a number");

    const funnel = await testEndpoint('/api/funnel');
    if (!Array.isArray(funnel)) throw new Error("funnel is not an array");
    if (funnel.length !== 5) throw new Error(`funnel has length ${funnel.length}, expected 5`);

    await testEndpoint('/api/anomaly');

    const sales = await testEndpoint('/api/sales');
    if (!sales.salesSummary || typeof sales.salesSummary.totalGMV !== 'number') {
      throw new Error("salesSummary totalGMV is missing or not a number");
    }
    if (!Array.isArray(sales.brandCorrelation)) throw new Error("brandCorrelation is not an array");

    console.log("=== ALL TESTS PASSED SUCCESSFULLY ===");
    process.exit(0);
  } catch (err) {
    console.error("=== TEST SUITE FAILED ===");
    console.error(err);
    process.exit(1);
  }
}

// Delay test run slightly to allow server to start
setTimeout(runTests, 2000);
