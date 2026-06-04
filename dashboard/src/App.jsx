import React, { useState, useEffect, useRef } from 'react';
import { 
  Users, ShoppingBag, Clock, TrendingUp, DollarSign, 
  AlertTriangle, ShieldAlert, Zap, MapPin, RefreshCw,
  Camera, ShoppingCart, HelpCircle, Upload, X, CheckCircle
} from 'lucide-react';

const API_BASE = '/api';

export default function App() {
  const [metrics, setMetrics] = useState({
    footfall: 0,
    activeCustomers: 0,
    staffInStore: 0,
    avgDwellMinutes: 0.0,
    totalOrders: 0,
    conversionRate: 0.0,
    totalGMV: 0
  });

  const [funnel, setFunnel] = useState([
    { step: 'Entered Store', count: 0, percentage: 100 },
    { step: 'Visited Shelves', count: 0, percentage: 0 },
    { step: 'Engaged Products', count: 0, percentage: 0 },
    { step: 'Initiated Checkout', count: 0, percentage: 0 },
    { step: 'Purchased', count: 0, percentage: 0 }
  ]);

  const [anomalies, setAnomalies] = useState([]);
  const [salesData, setSalesData] = useState({
    brandCorrelation: [],
    salespersonPerformance: {},
    planogramFeedback: {
      recommendation: "Analyzing layout performance...",
      performance: { addedGmv: 0, removedGmv: 0, netImpact: 0 }
    }
  });

  const [liveEvents, setLiveEvents] = useState([]);
  const [activeTab, setActiveTab] = useState('events'); // events or anomalies
  const [connected, setConnected] = useState(false);
  const [isUploadModalOpen, setIsUploadModalOpen] = useState(false);
  const [uploadState, setUploadState] = useState({ status: 'idle', message: '' }); // idle, uploading, success, error
  const fileInputRef = useRef(null);
  const wsRef = useRef(null);

  const handleUpload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    
    setUploadState({ status: 'uploading', message: 'Uploading video (this may take a moment)...' });
    const formData = new FormData();
    formData.append('video', file);
    
    try {
      const res = await fetch('/api/upload-video', {
        method: 'POST',
        body: formData
      });
      const data = await res.json();
      if (res.ok) {
        setUploadState({ status: 'success', message: 'Video uploaded! The pipeline is now processing it.' });
        setTimeout(() => { setIsUploadModalOpen(false); setUploadState({ status: 'idle', message: '' }); }, 3000);
      } else {
        setUploadState({ status: 'error', message: data.error || 'Upload failed' });
      }
    } catch (err) {
      setUploadState({ status: 'error', message: 'Network error during upload' });
    }
  };

  // Fetch API metrics
  const fetchAllData = async () => {
    try {
      const resMetrics = await fetch(`${API_BASE}/metrics`);
      const dataMetrics = await resMetrics.json();
      setMetrics(dataMetrics);

      const resFunnel = await fetch(`${API_BASE}/funnel`);
      const dataFunnel = await resFunnel.json();
      setFunnel(dataFunnel);

      const resAnomaly = await fetch(`${API_BASE}/anomaly`);
      const dataAnomaly = await resAnomaly.json();
      setAnomalies(dataAnomaly);

      const resSales = await fetch(`${API_BASE}/sales`);
      const dataSales = await resSales.json();
      setSalesData(dataSales);
    } catch (e) {
      console.error("Error fetching dashboard data:", e);
    }
  };

  // Set up WebSocket connection for real-time alerts
  useEffect(() => {
    fetchAllData();
    // Refresh API data every 5 seconds
    const interval = setInterval(fetchAllData, 5000);

    // Initialize WebSocket — connect through nginx /ws proxy (same port as dashboard)
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;
    
    const connectWS = () => {
      console.log(`Connecting to WebSocket at: ${wsUrl}`);
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        setConnected(true);
        console.log("WebSocket connected.");
      };

      ws.onmessage = (evt) => {
        try {
          const data = JSON.parse(evt.data);
          
          if (data.event_type === 'ANOMALY_DETECTED') {
            setAnomalies(prev => [data.anomaly, ...prev].slice(0, 30));
          } else {
            // Push to live events ticker
            setLiveEvents(prev => [data, ...prev].slice(0, 40));
          }
        } catch (err) {
          console.error("Error parsing WS message:", err);
        }
      };

      ws.onclose = () => {
        setConnected(false);
        console.log("WebSocket closed. Reconnecting in 3s...");
        setTimeout(connectWS, 3000);
      };

      ws.onerror = (err) => {
        console.error("WebSocket error:", err);
        ws.close();
      };
    };

    connectWS();

    return () => {
      clearInterval(interval);
      if (wsRef.current) wsRef.current.close();
    };
  }, []);

  return (
    <div style={{ padding: '30px', maxWidth: '1600px', margin: '0 auto' }}>
      {/* Header */}
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '35px' }}>
        <div>
          <h1 style={{ fontSize: '32px', color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: '10px' }}>
            <Zap size={30} style={{ color: 'var(--primary)' }} />
            AURA <span style={{ fontWeight: '300', color: 'var(--cyan)', fontSize: '24px' }}>Store Intelligence System</span>
          </h1>
          <p style={{ color: 'var(--text-secondary)', marginTop: '5px' }}>AI-Powered Omnichannel Customer Behavior &amp; Retail Analytics</p>
        </div>
        <div style={{ display: 'flex', gap: '15px', alignItems: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', background: 'rgba(255,255,255,0.03)', padding: '8px 16px', borderRadius: '20px', border: '1px solid var(--panel-border)' }}>
            <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: connected ? 'var(--green)' : 'var(--red)', display: 'inline-block' }}></span>
            <span style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>{connected ? 'LIVE EVENT STREAM CONNECTED' : 'OFFLINE - RECONNECTING'}</span>
          </div>
          <button onClick={() => setIsUploadModalOpen(true)} className="panel" style={{ padding: '8px 16px', borderRadius: '20px', display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', background: 'rgba(139, 92, 246, 0.15)', color: 'var(--primary)', border: '1px solid rgba(139, 92, 246, 0.3)' }}>
            <Upload size={16} />
            <span style={{ fontSize: '13px', fontWeight: 'bold' }}>Upload Video</span>
          </button>
          <button onClick={fetchAllData} className="panel" style={{ padding: '8px 12px', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
            <RefreshCw size={16} />
          </button>
        </div>
      </header>

      {/* Upload Modal */}
      {isUploadModalOpen && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.8)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <div style={{ background: 'var(--panel-bg)', border: '1px solid var(--panel-border)', borderRadius: '12px', padding: '30px', width: '400px', position: 'relative', boxShadow: '0 20px 40px rgba(0,0,0,0.5)' }}>
            <button onClick={() => setIsUploadModalOpen(false)} style={{ position: 'absolute', top: '15px', right: '15px', background: 'transparent', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer' }}>
              <X size={20} />
            </button>
            <h3 style={{ marginTop: 0, marginBottom: '20px', color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: '10px' }}>
              <Upload size={20} style={{ color: 'var(--primary)' }} /> Upload CCTV Footage
            </h3>
            
            <p style={{ color: 'var(--text-secondary)', fontSize: '14px', marginBottom: '20px', lineHeight: '1.5' }}>
              Upload an MP4 file to run through the YOLOv8 Computer Vision pipeline online. The simulation will pause while processing.
            </p>

            <div style={{ 
              border: '2px dashed rgba(139, 92, 246, 0.3)', 
              borderRadius: '8px', 
              padding: '30px', 
              textAlign: 'center',
              background: 'rgba(0,0,0,0.2)',
              cursor: uploadState.status === 'uploading' ? 'default' : 'pointer'
            }} onClick={() => uploadState.status !== 'uploading' && fileInputRef.current.click()}>
              <input type="file" accept="video/mp4" ref={fileInputRef} onChange={handleUpload} style={{ display: 'none' }} />
              
              {uploadState.status === 'idle' && (
                <>
                  <Camera size={32} style={{ color: 'var(--text-secondary)', margin: '0 auto 10px auto' }} />
                  <p style={{ color: 'var(--primary)', fontWeight: 'bold', margin: 0 }}>Click to browse</p>
                  <p style={{ color: 'var(--text-secondary)', fontSize: '12px', margin: '5px 0 0 0' }}>Maximum file size: 500MB</p>
                </>
              )}
              
              {uploadState.status === 'uploading' && (
                <div style={{ color: 'var(--cyan)' }}>
                  <RefreshCw size={32} className="animate-spin" style={{ margin: '0 auto 10px auto' }} />
                  <p style={{ fontWeight: 'bold', margin: 0 }}>{uploadState.message}</p>
                </div>
              )}
              
              {uploadState.status === 'success' && (
                <div style={{ color: 'var(--green)' }}>
                  <CheckCircle size={32} style={{ margin: '0 auto 10px auto' }} />
                  <p style={{ fontWeight: 'bold', margin: 0 }}>{uploadState.message}</p>
                </div>
              )}
              
              {uploadState.status === 'error' && (
                <div style={{ color: 'var(--red)' }}>
                  <AlertTriangle size={32} style={{ margin: '0 auto 10px auto' }} />
                  <p style={{ fontWeight: 'bold', margin: 0 }}>{uploadState.message}</p>
                  <p style={{ fontSize: '12px', marginTop: '5px', color: 'var(--text-secondary)' }}>Click to try again</p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Metrics Row */}
      <section style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '20px', marginBottom: '35px' }}>
        <div className="panel" style={{ display: 'flex', alignItems: 'center', gap: '20px' }}>
          <div style={{ background: 'rgba(139, 92, 246, 0.1)', padding: '15px', borderRadius: '12px', color: 'var(--primary)' }}>
            <Users size={28} />
          </div>
          <div>
            <p style={{ fontSize: '13px', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Total Footfall</p>
            <h3 style={{ fontSize: '28px', marginTop: '4px' }}>{metrics.footfall}</h3>
          </div>
        </div>

        <div className="panel" style={{ display: 'flex', alignItems: 'center', gap: '20px' }}>
          <div style={{ background: 'rgba(6, 182, 212, 0.1)', padding: '15px', borderRadius: '12px', color: 'var(--cyan)' }}>
            <Users size={28} className="glow-active" style={{ borderRadius: '50%' }} />
          </div>
          <div>
            <p style={{ fontSize: '13px', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Active Shoppers</p>
            <h3 style={{ fontSize: '28px', marginTop: '4px', color: 'var(--cyan)' }}>{metrics.activeCustomers}</h3>
          </div>
        </div>

        <div className="panel" style={{ display: 'flex', alignItems: 'center', gap: '20px' }}>
          <div style={{ background: 'rgba(16, 185, 129, 0.1)', padding: '15px', borderRadius: '12px', color: 'var(--green)' }}>
            <TrendingUp size={28} />
          </div>
          <div>
            <p style={{ fontSize: '13px', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Conversion Rate</p>
            <h3 style={{ fontSize: '28px', marginTop: '4px', color: 'var(--green)' }}>{metrics.conversionRate}%</h3>
          </div>
        </div>

        <div className="panel" style={{ display: 'flex', alignItems: 'center', gap: '20px' }}>
          <div style={{ background: 'rgba(245, 158, 11, 0.1)', padding: '15px', borderRadius: '12px', color: 'var(--orange)' }}>
            <Clock size={28} />
          </div>
          <div>
            <p style={{ fontSize: '13px', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Avg. Dwell Time</p>
            <h3 style={{ fontSize: '28px', marginTop: '4px' }}>{metrics.avgDwellMinutes}m</h3>
          </div>
        </div>

        <div className="panel" style={{ display: 'flex', alignItems: 'center', gap: '20px' }}>
          <div style={{ background: 'rgba(139, 92, 246, 0.1)', padding: '15px', borderRadius: '12px', color: 'var(--primary)' }}>
            <DollarSign size={28} />
          </div>
          <div>
            <p style={{ fontSize: '13px', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Live Sales GMV</p>
            <h3 style={{ fontSize: '28px', marginTop: '4px' }}>₹{metrics.totalGMV}</h3>
          </div>
        </div>
      </section>

      {/* Main Grid */}
      <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr', gap: '30px', marginBottom: '35px' }}>
        
        {/* Left column: Layout & Funnel */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '30px' }}>
          
          {/* Store Layout Planogram Visualizer */}
          <div className="panel">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
              <h3 style={{ fontSize: '18px', display: 'flex', alignItems: 'center', gap: '10px' }}>
                <MapPin size={20} style={{ color: 'var(--primary)' }} />
                Real-Time Store Heatmap &amp; Planogram Monitor
              </h3>
              <div style={{ display: 'flex', gap: '10px', fontSize: '12px' }}>
                <span style={{ background: 'rgba(239, 68, 68, 0.2)', color: 'var(--red)', padding: '2px 8px', borderRadius: '4px' }}>HIGH DWELL</span>
                <span style={{ background: 'rgba(139, 92, 246, 0.2)', color: 'var(--primary)', padding: '2px 8px', borderRadius: '4px' }}>MID TRAFFIC</span>
                <span style={{ background: 'rgba(255,255,255,0.05)', color: 'var(--text-secondary)', padding: '2px 8px', borderRadius: '4px' }}>LOW TRAFFIC</span>
              </div>
            </div>

            {/* Layout Grid */}
            <div style={{ background: 'rgba(0,0,0,0.2)', borderRadius: '12px', border: '1px dashed var(--panel-border)', padding: '30px', position: 'relative' }}>
              
              {/* Top Wall Shelves */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(8, 1fr)', gap: '10px', marginBottom: '40px' }}>
                {['Suns', 'TFS', 'Gubb', 'DermDoc', 'Minimalist', 'Aqualogica', 'Foxtale', 'JC'].map((shelf, idx) => {
                  // Simulate heatmap colors
                  let bg = 'rgba(255, 255, 255, 0.02)';
                  let border = '1px solid var(--panel-border)';
                  if (shelf === 'TFS' || shelf === 'DermDoc') {
                    bg = 'rgba(239, 68, 68, 0.08)';
                    border = '1px solid var(--red)';
                  } else if (shelf === 'Minimalist' || shelf === 'Foxtale') {
                    bg = 'rgba(139, 92, 246, 0.08)';
                    border = '1px solid var(--primary)';
                  }
                  return (
                    <div key={idx} style={{ background: bg, border: border, padding: '12px 6px', borderRadius: '8px', textAlign: 'center', fontSize: '11px' }}>
                      <span style={{ display: 'block', fontWeight: 'bold', color: 'var(--text-secondary)', marginBottom: '4px' }}>SHELF</span>
                      {shelf}
                    </div>
                  );
                })}
              </div>

              {/* FOH (Front of House) Central Units */}
              <div style={{ display: 'flex', justifyContent: 'space-around', alignItems: 'center', margin: '40px 0', minHeight: '120px' }}>
                <div style={{ border: '1px solid var(--cyan)', background: 'rgba(6, 182, 212, 0.05)', padding: '20px', borderRadius: '10px', width: '120px', textAlign: 'center' }}>
                  <ShoppingCart size={20} style={{ color: 'var(--cyan)', marginBottom: '8px' }} />
                  <p style={{ fontSize: '12px', fontWeight: 'bold' }}>MAKE UP UNIT</p>
                </div>
                <div style={{ border: '1px solid var(--panel-border)', background: 'rgba(255,255,255,0.02)', padding: '20px', borderRadius: '10px', width: '120px', textAlign: 'center' }}>
                  <Users size={20} style={{ color: 'var(--text-secondary)', marginBottom: '8px' }} />
                  <p style={{ fontSize: '12px', fontWeight: 'bold' }}>F.O.H HUB</p>
                </div>
                <div style={{ border: '1px solid var(--orange)', background: 'rgba(245, 158, 11, 0.05)', padding: '20px', borderRadius: '10px', width: '120px', textAlign: 'center' }}>
                  <DollarSign size={20} style={{ color: 'var(--orange)', marginBottom: '8px' }} />
                  <p style={{ fontSize: '12px', fontWeight: 'bold' }}>CASH COUNTER</p>
                </div>
              </div>

              {/* Bottom Wall Shelves */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(9, 1fr)', gap: '10px' }}>
                {['BACKLIT', 'Macadamia', 'Faces', 'Lakme', 'Bare Anat.', 'Mens Care', 'Alps', "L'Oreal", 'Beauty Ess.'].map((shelf, idx) => {
                  let bg = 'rgba(255, 255, 255, 0.02)';
                  let border = '1px solid var(--panel-border)';
                  if (shelf === 'Faces' || shelf === 'Lakme') {
                    bg = 'rgba(239, 68, 68, 0.08)';
                    border = '1px solid var(--red)';
                  } else if (shelf === 'Alps' || shelf === "L'Oreal") {
                    bg = 'rgba(139, 92, 246, 0.08)';
                    border = '1px solid var(--primary)';
                  }
                  return (
                    <div key={idx} style={{ background: bg, border: border, padding: '12px 4px', borderRadius: '8px', textAlign: 'center', fontSize: '10px' }}>
                      <span style={{ display: 'block', fontWeight: 'bold', color: 'var(--text-secondary)', marginBottom: '4px' }}>SHELF</span>
                      {shelf}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Funnel Flow Chart */}
          <div className="panel">
            <h3 style={{ fontSize: '18px', marginBottom: '20px', display: 'flex', alignItems: 'center', gap: '10px' }}>
              <TrendingUp size={20} style={{ color: 'var(--primary)' }} />
              Customer Conversion Funnel
            </h3>
            
            <div style={{ display: 'flex', flexDirection: 'column', gap: '15px' }}>
              {funnel.map((item, idx) => (
                <div key={idx}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px', marginBottom: '6px' }}>
                    <span style={{ color: 'var(--text-primary)' }}>{item.step}</span>
                    <span style={{ color: 'var(--text-secondary)' }}>{item.count} sessions ({item.percentage}%)</span>
                  </div>
                  <div style={{ height: '8px', background: 'rgba(255,255,255,0.03)', borderRadius: '4px', overflow: 'hidden', border: '1px solid var(--panel-border)' }}>
                    <div style={{ height: '100%', width: `${item.percentage}%`, background: `linear-gradient(90deg, var(--primary), var(--cyan))`, borderRadius: '4px' }}></div>
                  </div>
                </div>
              ))}
            </div>
          </div>

        </div>

        {/* Right column: Events, Anomalies, Brand correlation */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '30px' }}>
          
          {/* Real-time Ticker & Anomalies */}
          <div className="panel" style={{ display: 'flex', flexDirection: 'column', height: '400px' }}>
            <div style={{ display: 'flex', borderBottom: '1px solid var(--panel-border)', paddingBottom: '15px', marginBottom: '15px', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ display: 'flex', gap: '20px' }}>
                <button 
                  onClick={() => setActiveTab('events')} 
                  style={{ background: 'none', border: 'none', color: activeTab === 'events' ? 'var(--primary)' : 'var(--text-secondary)', borderBottom: activeTab === 'events' ? '2px solid var(--primary)' : 'none', paddingBottom: '5px', fontWeight: 'bold', cursor: 'pointer', fontSize: '16px' }}
                >
                  Live Detection Feed
                </button>
                <button 
                  onClick={() => setActiveTab('anomalies')} 
                  style={{ background: 'none', border: 'none', color: activeTab === 'anomalies' ? 'var(--orange)' : 'var(--text-secondary)', borderBottom: activeTab === 'anomalies' ? '2px solid var(--orange)' : 'none', paddingBottom: '5px', fontWeight: 'bold', cursor: 'pointer', fontSize: '16px', display: 'flex', alignItems: 'center', gap: '6px' }}
                >
                  Anomaly Logs
                  {anomalies.length > 0 && (
                    <span style={{ background: 'var(--red)', color: 'white', borderRadius: '50%', width: '16px', height: '16px', fontSize: '10px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      {anomalies.length}
                    </span>
                  )}
                </button>
              </div>
              <Camera size={18} style={{ color: 'var(--text-secondary)' }} />
            </div>

            {/* List Content */}
            <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '10px' }}>
              {activeTab === 'events' ? (
                liveEvents.length === 0 ? (
                  <div style={{ textAlign: 'center', color: 'var(--text-secondary)', padding: '40px 0' }}>
                    <RefreshCw size={24} style={{ animation: 'spin 2s linear infinite', marginBottom: '10px' }} />
                    <p>Awaiting live events from video tracking pipeline...</p>
                  </div>
                ) : (
                  liveEvents.map((evt, idx) => (
                    <div key={idx} className="animate-slide-in" style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid var(--panel-border)', padding: '12px', borderRadius: '8px', fontSize: '12px' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                        <span style={{ fontWeight: 'bold', color: 'var(--primary)' }}>{evt.event_type}</span>
                        <span style={{ color: 'var(--text-secondary)' }}>{new Date(evt.timestamp).toLocaleTimeString()}</span>
                      </div>
                      <p style={{ color: 'var(--text-secondary)' }}>
                        Customer: <span style={{ color: 'var(--text-primary)' }}>{evt.customer_id}</span> | 
                        Camera: <span style={{ color: 'var(--text-primary)' }}>{evt.camera_id}</span>
                        {evt.zone && ` | Zone: ${evt.zone}`}
                        {evt.brand && ` | Brand: ${evt.brand}`}
                      </p>
                    </div>
                  ))
                )
              ) : (
                anomalies.length === 0 ? (
                  <div style={{ textAlign: 'center', color: 'var(--text-secondary)', padding: '40px 0' }}>
                    <ShieldAlert size={30} style={{ color: 'var(--green)', marginBottom: '10px' }} />
                    <p>No anomalies detected. Operations normal.</p>
                  </div>
                ) : (() => {
                  // Per-type config
                  const typeCfg = {
                    UNAUTHORIZED_ACCESS: { color: 'var(--red)',    bg: 'rgba(239,68,68,0.07)',   icon: '🚨', label: 'Unauthorized' },
                    LOITERING:           { color: 'var(--orange)', bg: 'rgba(245,158,11,0.07)',  icon: '⏱️', label: 'Loitering'    },
                    QUEUE_CONGESTION:    { color: 'var(--orange)', bg: 'rgba(245,158,11,0.07)',  icon: '👥', label: 'Queue Jam'    },
                    HIGH_DWELL:          { color: 'var(--cyan)',   bg: 'rgba(6,182,212,0.07)',   icon: '👁️', label: 'High Dwell'   },
                    CHECKOUT_ABANDONED:  { color: '#a78bfa',      bg: 'rgba(167,139,250,0.07)', icon: '🛒', label: 'Abandoned'    },
                  };
                  // Count by type for summary row
                  const counts = anomalies.reduce((acc, a) => { acc[a.type] = (acc[a.type]||0)+1; return acc; }, {});
                  return (
                    <>
                      {/* Summary badges */}
                      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '12px' }}>
                        {Object.entries(counts).map(([type, cnt]) => {
                          const cfg = typeCfg[type] || { color: 'var(--text-secondary)', icon: '⚠️', label: type };
                          return (
                            <span key={type} style={{ background: 'rgba(255,255,255,0.05)', border: `1px solid ${cfg.color}`, color: cfg.color, borderRadius: '20px', padding: '3px 10px', fontSize: '11px', fontWeight: '600', display: 'flex', alignItems: 'center', gap: '4px' }}>
                              {cfg.icon} {cfg.label} <span style={{ background: cfg.color, color: '#000', borderRadius: '50%', width: '16px', height: '16px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: '10px', fontWeight: '700' }}>{cnt}</span>
                            </span>
                          );
                        })}
                      </div>
                      {/* Anomaly cards */}
                      {anomalies.map((anom, idx) => {
                        const cfg = typeCfg[anom.type] || { color: 'var(--orange)', bg: 'rgba(245,158,11,0.07)', icon: '⚠️' };
                        const sevColor = anom.severity === 'HIGH' ? 'var(--red)' : anom.severity === 'MEDIUM' ? 'var(--orange)' : 'var(--cyan)';
                        return (
                          <div key={idx} className="animate-slide-in" style={{ background: cfg.bg, border: `1px solid ${cfg.color}`, padding: '12px', borderRadius: '8px', fontSize: '12px' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '6px' }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                                <span style={{ fontSize: '16px' }}>{cfg.icon}</span>
                                <span style={{ fontWeight: 'bold', color: cfg.color, fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{anom.type.replace(/_/g,' ')}</span>
                                <span style={{ background: sevColor, color: '#000', borderRadius: '4px', padding: '1px 6px', fontSize: '9px', fontWeight: '700' }}>{anom.severity}</span>
                              </div>
                              <span style={{ color: 'var(--text-secondary)', fontSize: '11px', whiteSpace: 'nowrap' }}>{new Date(anom.timestamp).toLocaleTimeString()}</span>
                            </div>
                            <p style={{ color: 'var(--text-primary)', lineHeight: '1.5', margin: 0 }}>{anom.description}</p>
                            {anom.customer_id && <p style={{ color: 'var(--text-secondary)', marginTop: '4px', fontSize: '10px' }}>ID: {anom.customer_id}</p>}
                          </div>
                        );
                      })}
                    </>
                  );
                })()
              )}
            </div>
          </div>

          {/* AI Planogram Feedback Panel */}
          <div className="panel" style={{ flex: 1 }}>
            <h3 style={{ fontSize: '18px', marginBottom: '15px', display: 'flex', alignItems: 'center', gap: '10px' }}>
              <Zap size={20} style={{ color: 'var(--cyan)' }} />
              AI Planogram Analysis &amp; Recommendation
            </h3>
            
            <div style={{ background: 'rgba(6, 182, 212, 0.03)', border: '1px solid rgba(6, 182, 212, 0.15)', padding: '16px', borderRadius: '10px', fontSize: '13px', lineHeight: '1.6', marginBottom: '20px' }}>
              <p style={{ color: 'var(--text-primary)', fontWeight: '500' }}>
                {salesData.planogramFeedback ? salesData.planogramFeedback.recommendation : 'Analyzing planogram impact...'}
              </p>
            </div>

            {/* Planogram stats */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '15px', fontSize: '12px' }}>
              <div style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid var(--panel-border)', padding: '12px', borderRadius: '8px' }}>
                <p style={{ color: 'var(--text-secondary)' }}>Revised Layout Gain</p>
                <h4 style={{ fontSize: '18px', color: 'var(--green)', marginTop: '4px' }}>
                  ₹{salesData.planogramFeedback ? salesData.planogramFeedback.performance.addedGmv.toFixed(0) : '0'}
                </h4>
              </div>
              <div style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid var(--panel-border)', padding: '12px', borderRadius: '8px' }}>
                <p style={{ color: 'var(--text-secondary)' }}>Current Layout Yield</p>
                <h4 style={{ fontSize: '18px', color: 'var(--text-secondary)', marginTop: '4px' }}>
                  ₹{salesData.planogramFeedback ? salesData.planogramFeedback.performance.removedGmv.toFixed(0) : '0'}
                </h4>
              </div>
            </div>
          </div>

        </div>
      </div>

      {/* Brand Correlation Table */}
      <section className="panel">
        <h3 style={{ fontSize: '18px', marginBottom: '20px', display: 'flex', alignItems: 'center', gap: '10px' }}>
          <ShoppingCart size={20} style={{ color: 'var(--primary)' }} />
          Brand Dwell-to-Revenue Correlation
        </h3>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '13px' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--panel-border)', color: 'var(--text-secondary)' }}>
                <th style={{ padding: '12px 15px' }}>Brand Name</th>
                <th style={{ padding: '12px 15px' }}>GMV Revenue</th>
                <th style={{ padding: '12px 15px' }}>Orders</th>
                <th style={{ padding: '12px 15px' }}>Total Dwell Time (Hrs)</th>
                <th style={{ padding: '12px 15px' }}>Dwell Sessions</th>
                <th style={{ padding: '12px 15px' }}>Conversion Rate</th>
                <th style={{ padding: '12px 15px' }}>Dwell-Revenue Index (₹/Hr)</th>
              </tr>
            </thead>
            <tbody>
              {salesData.brandCorrelation && salesData.brandCorrelation.length > 0 ? (
                salesData.brandCorrelation.slice(0, 10).map((brand, idx) => (
                  <tr key={idx} style={{ borderBottom: '1px solid rgba(255,255,255,0.03)' }}>
                    <td style={{ padding: '12px 15px', fontWeight: 'bold' }}>{brand.brand}</td>
                    <td style={{ padding: '12px 15px', color: 'var(--green)' }}>₹{brand.gmv}</td>
                    <td style={{ padding: '12px 15px' }}>{brand.orders}</td>
                    <td style={{ padding: '12px 15px' }}>{brand.dwellHours}h</td>
                    <td style={{ padding: '12px 15px' }}>{brand.dwellSessions}</td>
                    <td style={{ padding: '12px 15px' }}>
                      <span style={{ background: 'rgba(16, 185, 129, 0.1)', color: 'var(--green)', padding: '2px 8px', borderRadius: '4px', fontWeight: '500' }}>
                        {brand.conversionRate}%
                      </span>
                    </td>
                    <td style={{ padding: '12px 15px', color: 'var(--cyan)' }}>₹{brand.dwellRevenueIndex}/hr</td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan="7" style={{ textAlign: 'center', padding: '30px 0', color: 'var(--text-secondary)' }}>
                    Awaiting correlation data...
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
