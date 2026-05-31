const express = require('express');
const router = express.Router();
const db = require('./db');
const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');

// In-memory cache for transaction data
let transactions = [];
let salesSummary = {
  totalOrders: 0,
  totalGMV: 0,
  totalNMV: 0,
  brandSales: {},
  salespersonSales: {},
  brandOrders: {},
};

function loadTransactions() {
  const searchPaths = [
    path.join(__dirname, 'data', 'transactions.csv'),
    path.join(__dirname, '..', 'data', 'transactions.csv'),
    '/app/data/transactions.csv',
    './data/transactions.csv',
    path.join(__dirname, '..', '..', 'data', 'transactions.csv')
  ];
  let csvPath = null;
  for (const p of searchPaths) {
    if (fs.existsSync(p)) {
      csvPath = p;
      break;
    }
  }

  if (!csvPath) {
    console.error("Transactions CSV file not found in search paths:", searchPaths);
    return;
  }
  console.log("Loading transactions from:", csvPath);
  try {
    const fileContent = fs.readFileSync(csvPath, 'utf8');
    const records = parse(fileContent, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
    });
    
    transactions = records.map(r => ({
      orderId: r.order_id,
      couponCode: r.coupon_code || null,
      offerName: r.offer_name || null,
      orderDate: r.order_date,
      orderTime: r.order_time,
      customerName: r.customer_name,
      customerNumber: r.customer_number,
      productName: r.product_name,
      brandName: r.brand_name,
      qty: parseInt(r.qty || '1', 10),
      gmv: parseFloat(r.GMV || '0'),
      nmv: parseFloat(r.NMV || '0'),
      salespersonName: r.salesperson_name,
      subCategory: r.sub_category,
    }));

    // Aggregate
    const uniqueOrders = new Set();
    salesSummary.brandSales = {};
    salesSummary.salespersonSales = {};
    salesSummary.brandOrders = {};
    
    let gmvSum = 0;
    let nmvSum = 0;

    transactions.forEach(t => {
      uniqueOrders.add(t.orderId);
      gmvSum += t.gmv;
      nmvSum += t.nmv;

      // Brand aggregation
      const brand = t.brandName || 'Unknown';
      salesSummary.brandSales[brand] = (salesSummary.brandSales[brand] || 0) + t.gmv;
      if (!salesSummary.brandOrders[brand]) salesSummary.brandOrders[brand] = new Set();
      salesSummary.brandOrders[brand].add(t.orderId);

      // Salesperson aggregation
      const sp = t.salespersonName || 'Guest';
      if (!salesSummary.salespersonSales[sp]) {
        salesSummary.salespersonSales[sp] = { revenue: 0, orders: new Set() };
      }
      salesSummary.salespersonSales[sp].revenue += t.gmv;
      salesSummary.salespersonSales[sp].orders.add(t.orderId);
    });

    salesSummary.totalOrders = uniqueOrders.size;
    salesSummary.totalGMV = gmvSum;
    salesSummary.totalNMV = nmvSum;

    // Convert sets to size counts
    Object.keys(salesSummary.brandOrders).forEach(b => {
      salesSummary.brandOrders[b] = salesSummary.brandOrders[b].size;
    });
    Object.keys(salesSummary.salespersonSales).forEach(sp => {
      salesSummary.salespersonSales[sp].ordersCount = salesSummary.salespersonSales[sp].orders.size;
      delete salesSummary.salespersonSales[sp].orders;
    });

    console.log(`Successfully loaded ${transactions.length} transaction rows, ${salesSummary.totalOrders} unique orders.`);
  } catch (err) {
    console.error("Error loading transactions CSV:", err);
  }
}

// Load transaction data immediately
loadTransactions();

// Route: GET /metrics
const getMetrics = async (req, res) => {
  try {
    // Total footfall (unique sessions that are not staff)
    const footfallRes = await db.query(
      "SELECT COUNT(*) as count FROM sessions WHERE is_staff = FALSE"
    );
    const footfall = parseInt(footfallRes.rows[0].count || '0', 10);

    // Active customers (sessions with null end_time that are not staff)
    const activeRes = await db.query(
      "SELECT COUNT(*) as count FROM sessions WHERE end_time IS NULL AND is_staff = FALSE"
    );
    const active = parseInt(activeRes.rows[0].count || '0', 10);

    // Staff count
    const staffRes = await db.query(
      "SELECT COUNT(*) as count FROM sessions WHERE is_staff = TRUE"
    );
    const staff = parseInt(staffRes.rows[0].count || '0', 10);

    // Average Dwell Time in minutes (completed sessions that are not staff)
    const dwellRes = await db.query(
      "SELECT AVG(EXTRACT(EPOCH FROM (end_time - start_time))) as avg_dwell FROM sessions WHERE end_time IS NOT NULL AND is_staff = FALSE"
    );
    const avgDwellSeconds = parseFloat(dwellRes.rows[0].avg_dwell || '0');
    const avgDwellMinutes = parseFloat((avgDwellSeconds / 60).toFixed(2));

    // Conversion rate
    const conversionRate = footfall > 0 ? parseFloat(((salesSummary.totalOrders / footfall) * 100).toFixed(2)) : 0;

    res.json({
      footfall,
      activeCustomers: active,
      staffInStore: staff,
      avgDwellMinutes,
      totalOrders: salesSummary.totalOrders,
      conversionRate,
      totalGMV: parseFloat(salesSummary.totalGMV.toFixed(2)),
    });
  } catch (err) {
    console.error("Error executing /metrics query:", err);
    res.status(500).json({ error: "Internal server error" });
  }
};
router.get('/metrics', getMetrics);
router.get('/Metrics', getMetrics);

// Route: GET /funnel
const getFunnel = async (req, res) => {
  try {
    // Funnel Steps:
    // Step 1: Entered (Footfall)
    const footfallRes = await db.query("SELECT COUNT(*) as count FROM sessions WHERE is_staff = FALSE");
    const entered = parseInt(footfallRes.rows[0].count || '0', 10);

    // Step 2: Shelf Visitor (any customer who entered a brand shelf zone and has an entry session)
    const shelfRes = await db.query(`
      SELECT COUNT(DISTINCT customer_id) as count 
      FROM events 
      WHERE event_type = 'ZONE_ENTRY' AND is_staff = FALSE
        AND customer_id IN (SELECT customer_id FROM sessions WHERE is_staff = FALSE)
    `);
    let shelfVisitors = parseInt(shelfRes.rows[0].count || '0', 10);
    shelfVisitors = Math.min(shelfVisitors, entered);

    // Step 3: Product Engaged (any customer with an INTERACTION event and has an entry session)
    const interactionRes = await db.query(`
      SELECT COUNT(DISTINCT customer_id) as count 
      FROM events 
      WHERE event_type = 'INTERACTION' AND is_staff = FALSE
        AND customer_id IN (SELECT customer_id FROM sessions WHERE is_staff = FALSE)
    `);
    let engaged = parseInt(interactionRes.rows[0].count || '0', 10);
    engaged = Math.min(engaged, shelfVisitors);

    // Step 4: Checkout Start (customer entered checkout counter zone and has an entry session)
    const checkoutRes = await db.query(`
      SELECT COUNT(DISTINCT customer_id) as count 
      FROM events 
      WHERE event_type = 'CHECKOUT_START' AND is_staff = FALSE
        AND customer_id IN (SELECT customer_id FROM sessions WHERE is_staff = FALSE)
    `);
    let checkoutStarted = parseInt(checkoutRes.rows[0].count || '0', 10);
    checkoutStarted = Math.min(checkoutStarted, engaged);

    // Step 5: Completed Transaction
    let purchased = salesSummary.totalOrders;
    purchased = Math.min(purchased, checkoutStarted);

    res.json([
      { step: 'Entered Store', count: entered, percentage: 100 },
      { step: 'Visited Shelves', count: shelfVisitors, percentage: entered > 0 ? parseFloat(((shelfVisitors / entered) * 100).toFixed(1)) : 0 },
      { step: 'Engaged Products', count: engaged, percentage: shelfVisitors > 0 ? parseFloat(((engaged / shelfVisitors) * 100).toFixed(1)) : 0 },
      { step: 'Initiated Checkout', count: checkoutStarted, percentage: engaged > 0 ? parseFloat(((checkoutStarted / engaged) * 100).toFixed(1)) : 0 },
      { step: 'Purchased', count: purchased, percentage: checkoutStarted > 0 ? parseFloat(((purchased / checkoutStarted) * 100).toFixed(1)) : 0 }
    ]);
  } catch (err) {
    console.error("Error executing /funnel query:", err);
    res.status(500).json({ error: "Internal server error" });
  }
};
router.get('/funnel', getFunnel);
router.get('/Funnel', getFunnel);

// Route: GET /anomaly
const getAnomaly = async (req, res) => {
  try {
    const result = await db.query(
      "SELECT * FROM anomalies ORDER BY timestamp DESC LIMIT 50"
    );
    res.json(result.rows);
  } catch (err) {
    console.error("Error executing /anomaly query:", err);
    res.status(500).json({ error: "Internal server error" });
  }
};
router.get('/anomaly', getAnomaly);
router.get('/Anomaly', getAnomaly);

// Route: GET /sales (Planogram & Correlation)
const getSales = async (req, res) => {
  try {
    // 1. Get dwell times per brand
    const dwellRes = await db.query(`
      SELECT brand, SUM(dwell_seconds) as total_dwell, COUNT(DISTINCT customer_id) as unique_sessions 
      FROM brand_dwell 
      GROUP BY brand
    `);
    
    const brandDwellMap = {};
    dwellRes.rows.forEach(r => {
      brandDwellMap[r.brand.toLowerCase()] = {
        totalDwellSeconds: parseInt(r.total_dwell, 10),
        uniqueSessions: parseInt(r.unique_sessions, 10)
      };
    });

    // 2. Correlate with brand GMV and calculate Conversion / Dwell Revenue Index
    const correlation = [];
    const brandsList = Object.keys(salesSummary.brandSales);

    brandsList.forEach(brand => {
      const gmv = salesSummary.brandSales[brand] || 0;
      const orders = salesSummary.brandOrders[brand] || 0;
      
      const dwellInfo = brandDwellMap[brand.toLowerCase()] || { totalDwellSeconds: 0, uniqueSessions: 0 };
      const dwellHours = parseFloat((dwellInfo.totalDwellSeconds / 3600).toFixed(2));
      
      // Dwell to Revenue Index = GMV / Dwell Hour
      const revenueIndex = dwellHours > 0 ? parseFloat((gmv / dwellHours).toFixed(2)) : 0;
      
      // Brand conversion rate = Orders / Unique Dwell Sessions
      const conversion = dwellInfo.uniqueSessions > 0 
        ? parseFloat(((orders / dwellInfo.uniqueSessions) * 100).toFixed(2)) 
        : 0;

      correlation.push({
        brand,
        gmv: parseFloat(gmv.toFixed(2)),
        orders,
        dwellHours,
        dwellSessions: dwellInfo.uniqueSessions,
        conversionRate: Math.min(conversion, 100), // Cap at 100%
        dwellRevenueIndex: revenueIndex
      });
    });

    // Sort by GMV descending
    correlation.sort((a, b) => b.gmv - a.gmv);

    // 3. Planogram Optimization Metrics: Revised vs Current Layout analysis
    const planogram = {
      removedBrands: ['Pilgrim', 'D&K'],
      addedBrands: ['Foxtale', 'Juicy Chemistry'],
      performance: {
        addedGmv: 0,
        removedGmv: 0,
      }
    };

    brandsList.forEach(brand => {
      const gmv = salesSummary.brandSales[brand] || 0;
      if (['Foxtale', 'Juicy Chemistry'].some(b => brand.toLowerCase().includes(b.toLowerCase()))) {
        planogram.performance.addedGmv += gmv;
      }
      if (['Pilgrim', 'D&K', 'D & K'].some(b => brand.toLowerCase().includes(b.toLowerCase()))) {
        planogram.performance.removedGmv += gmv;
      }
    });

    planogram.performance.netImpact = planogram.performance.addedGmv - planogram.performance.removedGmv;
    planogram.recommendation = planogram.performance.netImpact > 0 
      ? "Strongly recommend deploying the Revised layout permanently. The inclusion of Foxtale and Juicy Chemistry on the top wall shelves has increased store yield by " + planogram.performance.netImpact.toFixed(2) + " INR."
      : "The Current layout is performing optimally. Replacing Pilgrim and D&K with Foxtale and Juicy Chemistry resulted in a slight yield decline.";

    res.json({
      salesSummary: {
        totalOrders: salesSummary.totalOrders,
        totalGMV: parseFloat(salesSummary.totalGMV.toFixed(2)),
        totalNMV: parseFloat(salesSummary.totalNMV.toFixed(2)),
      },
      brandCorrelation: correlation,
      salespersonPerformance: salesSummary.salespersonSales,
      planogramFeedback: planogram
    });
  } catch (err) {
    console.error("Error executing /sales correlation queries:", err);
    res.status(500).json({ error: "Internal server error" });
  }
};
router.get('/sales', getSales);
router.get('/Sales', getSales);

module.exports = router;
