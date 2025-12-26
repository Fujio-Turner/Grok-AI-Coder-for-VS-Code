#!/usr/bin/env python3
"""
Error Dashboard v3 - Dev tool for viewing all bugs and errors from Grok AI Coder sessions.

Features:
- JSON viewer popup with pair highlighting
- Group by session or error type
- Condensed "errors only" view
- **NEW: AI Inputs tab - debug package for AI assistants**

Usage:
    pip install -r requirements.txt
    python error_dashboard.py

Then open http://localhost:5050
"""

import os
import json
from datetime import datetime, timedelta
from flask import Flask, render_template_string, jsonify, request
import requests
from requests.auth import HTTPBasicAuth

app = Flask(__name__)

# Couchbase config
CB_HOST = os.environ.get('CB_HOST', 'localhost')
CB_PORT = os.environ.get('CB_PORT', '8093')
CB_USER = os.environ.get('CB_USER', 'Administrator')
CB_PASS = os.environ.get('CB_PASS', 'password')
CB_BUCKET = os.environ.get('CB_BUCKET', 'grokCoder')

def build_time_series(errors: list, time_range: str, total_sessions: int, session_stats: list = None) -> list:
    """Build time series data for charts, grouped by appropriate time buckets."""
    from collections import defaultdict
    
    # Determine bucket format based on time range
    if time_range == 'hour':
        bucket_format = '%H:%M'
    elif time_range == 'day':
        bucket_format = '%H:00'
    elif time_range == 'week':
        bucket_format = '%m/%d'
    else:  # month or all
        bucket_format = '%m/%d'
    
    # Group errors by time bucket
    time_buckets = defaultdict(lambda: {
        'bugs': 0, 'failures': 0, 'errors': 0, 'sessions': set(),
        'tokensIn': 0, 'tokensOut': 0, 'totalSizeBytes': 0
    })
    
    for e in errors:
        ts = e.get('timestamp', '')
        if not ts:
            continue
        try:
            dt = datetime.fromisoformat(ts.replace('Z', '+00:00'))
            bucket_key = dt.strftime(bucket_format)
            time_buckets[bucket_key][e['type'] + 's'] = time_buckets[bucket_key].get(e['type'] + 's', 0) + 1
            time_buckets[bucket_key]['sessions'].add(e.get('sessionId', ''))
        except:
            pass
    
    # Add session stats (tokens, size) to buckets
    if session_stats:
        for s in session_stats:
            ts = s.get('updatedAt', '')
            if not ts:
                continue
            try:
                dt = datetime.fromisoformat(ts.replace('Z', '+00:00'))
                bucket_key = dt.strftime(bucket_format)
                time_buckets[bucket_key]['tokensIn'] += s.get('tokensIn', 0) or 0
                time_buckets[bucket_key]['tokensOut'] += s.get('tokensOut', 0) or 0
                # Estimate size: ~4 bytes per token as rough estimate
                estimated_size = ((s.get('tokensIn', 0) or 0) + (s.get('tokensOut', 0) or 0)) * 4
                time_buckets[bucket_key]['totalSizeBytes'] += estimated_size
                time_buckets[bucket_key]['sessions'].add(s.get('id', ''))
            except:
                pass
    
    # Convert to list and calculate averages
    result = []
    for period, data in sorted(time_buckets.items()):
        session_count = len(data['sessions']) or 1
        total_errors = data.get('bugs', 0) + data.get('failures', 0) + data.get('errors', 0)
        result.append({
            'period': period,
            'bugs': data.get('bugs', 0),
            'failures': data.get('failures', 0),
            'errors': data.get('errors', 0),
            'avgPerSession': round(total_errors / session_count, 2),
            'tokensIn': data.get('tokensIn', 0),
            'tokensOut': data.get('tokensOut', 0),
            'avgSessionSizeKB': round((data.get('totalSizeBytes', 0) / session_count) / 1024, 1)
        })
    
    return result

def query_couchbase(n1ql: str, params: dict = None) -> list:
    """Execute N1QL query against Couchbase."""
    url = f"http://{CB_HOST}:{CB_PORT}/query/service"
    payload = {"statement": n1ql}
    if params:
        for k, v in params.items():
            payload["$" + k] = v
    
    try:
        resp = requests.post(
            url,
            auth=HTTPBasicAuth(CB_USER, CB_PASS),
            headers={"Content-Type": "application/json"},
            json=payload,
            timeout=30
        )
        resp.raise_for_status()
        data = resp.json()
        return data.get("results", [])
    except Exception as e:
        print(f"Query error: {e}")
        return []

DASHBOARD_HTML = """
<!DOCTYPE html>
<html>
<head>
    <title>🐛 Error Dashboard v3 - Grok AI Coder</title>
    <script src="https://cdn.jsdelivr.net/npm/echarts@5.4.3/dist/echarts.min.js"></script>
    <style>
        * { box-sizing: border-box; }
        body { 
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: #1e1e1e; color: #d4d4d4; margin: 0; padding: 20px;
        }
        h1 { color: #4ec9b0; margin-bottom: 5px; }
        .subtitle { color: #888; margin-bottom: 20px; }
        
        .filters { background: #252526; padding: 15px; border-radius: 8px; margin-bottom: 20px; display: flex; gap: 15px; align-items: center; flex-wrap: wrap; }
        .filters select, .filters input { background: #3c3c3c; border: 1px solid #555; color: #fff; padding: 8px 12px; border-radius: 4px; }
        .filters button { background: #0e639c; color: #fff; border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer; }
        .filters button:hover { background: #1177bb; }
        .filters button.active { background: #4ec9b0; color: #000; }
        
        .stats { display: flex; gap: 20px; margin-bottom: 20px; }
        .stat-card { background: #252526; padding: 15px 25px; border-radius: 8px; text-align: center; cursor: pointer; transition: transform 0.1s; }
        .stat-card:hover { transform: scale(1.05); }
        .stat-card .number { font-size: 2em; font-weight: bold; }
        .stat-card.bugs .number { color: #f14c4c; }
        .stat-card.failures .number { color: #cca700; }
        .stat-card.errors .number { color: #cc6633; }
        .stat-card.cli .number { color: #c586c0; }
        .stat-card.sessions .number { color: #569cd6; }
        .stat-card .label { color: #888; font-size: 0.9em; }
        
        table { width: 100%; border-collapse: collapse; background: #252526; border-radius: 8px; overflow: hidden; }
        th { background: #333; text-align: left; padding: 12px 15px; color: #4ec9b0; position: sticky; top: 0; }
        td { padding: 10px 15px; border-top: 1px solid #333; vertical-align: top; }
        tr:hover { background: #2a2a2a; }
        tr.group-header { background: #1a3a5a; }
        tr.group-header td { font-weight: bold; color: #4ec9b0; padding: 8px 15px; }
        
        .type-badge { padding: 3px 8px; border-radius: 4px; font-size: 0.85em; font-weight: 500; }
        .type-bug { background: #4b1818; color: #f14c4c; }
        .type-failure { background: #4b3c00; color: #cca700; }
        .type-error { background: #4b2800; color: #cc6633; }
        .type-cli { background: #3a184b; color: #c586c0; }
        .category-truncation { background: #4b1848; color: #c94eb0; }
        .category-json { background: #184b48; color: #4ec9b0; }
        .category-api { background: #4b4818; color: #ccaa00; }
        .category-cli { background: #3a184b; color: #c586c0; }
        .user-badge { background: #1a4b1a; color: #4edc4e; padding: 2px 6px; border-radius: 4px; font-size: 0.75em; margin-left: 6px; font-weight: bold; }
        .session-type-badge { padding: 2px 6px; border-radius: 4px; font-size: 0.7em; margin-left: 4px; }
        .session-type-single { background: #1a3a4a; color: #6ab0de; }
        .session-type-extended { background: #4a3a1a; color: #deb06a; }
        .session-type-handoff { background: #3a1a4a; color: #b06ade; }
        
        .timestamp { color: #888; font-size: 0.9em; }
        .session-link { color: #569cd6; text-decoration: none; cursor: pointer; }
        .session-link:hover { text-decoration: underline; }
        .description { max-width: 400px; word-wrap: break-word; }
        .empty { text-align: center; padding: 40px; color: #888; }
        .refresh-btn { float: right; }
        .view-btn { background: #333; color: #4ec9b0; border: 1px solid #4ec9b0; padding: 4px 10px; border-radius: 4px; cursor: pointer; font-size: 0.85em; }
        .view-btn:hover { background: #4ec9b0; color: #000; }
        
        /* Modal */
        .modal-overlay { display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.8); z-index: 1000; }
        .modal-overlay.active { display: flex; justify-content: center; align-items: center; }
        .modal { background: #252526; border-radius: 8px; width: 90%; max-width: 1200px; max-height: 90vh; display: flex; flex-direction: column; }
        .modal-header { padding: 15px 20px; border-bottom: 1px solid #333; display: flex; justify-content: space-between; align-items: center; }
        .modal-header h2 { margin: 0; color: #4ec9b0; font-size: 1.2em; }
        .modal-close { background: none; border: none; color: #888; font-size: 24px; cursor: pointer; }
        .modal-close:hover { color: #fff; }
        .modal-tabs { display: flex; border-bottom: 1px solid #333; }
        .modal-tab { padding: 10px 20px; cursor: pointer; color: #888; border-bottom: 2px solid transparent; }
        .modal-tab:hover { color: #fff; }
        .modal-tab.active { color: #4ec9b0; border-bottom-color: #4ec9b0; }
        .modal-tab.ai-tab { color: #c94eb0; }
        .modal-tab.ai-tab.active { border-bottom-color: #c94eb0; }
        .modal-body { flex: 1; overflow: auto; padding: 0; }
        
        .json-viewer { font-family: 'Monaco', 'Menlo', monospace; font-size: 13px; line-height: 1.5; white-space: pre; padding: 20px; }
        .json-line { padding: 2px 10px; }
        .json-line:hover { background: #333; }
        .json-line.highlight { background: #4b1818; border-left: 3px solid #f14c4c; }
        .json-line.error-context { background: #3a2a1a; }
        .json-key { color: #9cdcfe; }
        .json-string { color: #ce9178; }
        .json-number { color: #b5cea8; }
        .json-boolean { color: #569cd6; }
        .json-null { color: #569cd6; }
        
        .errors-summary { padding: 20px; }
        .error-card { background: #1a1a1a; border: 1px solid #333; border-radius: 8px; margin-bottom: 15px; overflow: hidden; }
        .error-card-header { background: #333; padding: 10px 15px; display: flex; justify-content: space-between; align-items: center; }
        .error-card-body { padding: 15px; }
        .error-card pre { margin: 0; white-space: pre-wrap; font-size: 12px; }
        
        .copy-btn { background: #333; color: #888; border: 1px solid #555; padding: 4px 10px; border-radius: 4px; cursor: pointer; font-size: 0.85em; }
        .copy-btn:hover { background: #444; color: #fff; }
        .copy-btn.copied { background: #2a5a2a; color: #4ec9b0; }
        .copy-btn.large { padding: 12px 24px; font-size: 1.1em; background: #4b1848; color: #c94eb0; border-color: #c94eb0; }
        .copy-btn.large:hover { background: #c94eb0; color: #000; }
        
        /* AI Inputs Tab Styles */
        .ai-inputs { padding: 20px; }
        .ai-inputs h3 { color: #c94eb0; margin-top: 0; }
        .ai-inputs-intro { background: #2a1a3a; border: 1px solid #c94eb0; border-radius: 8px; padding: 15px; margin-bottom: 20px; }
        .ai-inputs-intro p { margin: 0 0 10px 0; }
        .debug-section { background: #1a1a1a; border: 1px solid #333; border-radius: 8px; margin-bottom: 15px; }
        .debug-section-header { background: #333; padding: 10px 15px; font-weight: bold; color: #4ec9b0; display: flex; justify-content: space-between; align-items: center; }
        .debug-section-body { padding: 15px; max-height: 300px; overflow: auto; }
        .debug-section pre { margin: 0; white-space: pre-wrap; font-size: 12px; font-family: 'Monaco', 'Menlo', monospace; }
        .debug-label { color: #888; font-size: 0.9em; margin-bottom: 5px; }
        .debug-value { background: #0a0a0a; padding: 10px; border-radius: 4px; margin-bottom: 10px; }
        .priority-high { border-left: 3px solid #f14c4c; }
        .priority-medium { border-left: 3px solid #cca700; }
        .priority-low { border-left: 3px solid #4ec9b0; }
        
        /* Charts */
        .charts-row { display: flex; gap: 20px; margin-bottom: 20px; flex-wrap: wrap; }
        .chart-card { background: #252526; border-radius: 8px; padding: 15px; flex: 1; min-width: 300px; }
        .chart-card h4 { margin: 0 0 10px 0; color: #4ec9b0; font-size: 0.95em; }
        .chart-container { position: relative; height: 200px; }
    </style>
</head>
<body>
    <h1>🐛 Error Dashboard v3 <button class="refresh-btn" onclick="loadData()">🔄 Refresh</button></h1>
    <p class="subtitle">Bugs, failures, and errors from Grok AI Coder sessions</p>
    
    <div class="filters">
        <label>Time range:</label>
        <select id="timeRange" onchange="loadData()">
            <option value="hour">Last hour</option>
            <option value="day" selected>Last 24 hours</option>
            <option value="week">Last 7 days</option>
            <option value="month">Last 30 days</option>
            <option value="all">All time</option>
        </select>
        <label>Type:</label>
        <select id="typeFilter" onchange="filterTable()">
            <option value="all">All types</option>
            <option value="bug">Bugs only</option>
            <option value="bug-user">👤 User-reported only</option>
            <option value="failure">Failures only</option>
            <option value="error">Pair errors only</option>
            <option value="cli">🖥️ CLI failures only</option>
        </select>
        <label>Category:</label>
        <select id="categoryFilter" onchange="filterTable()">
            <option value="all">All categories</option>
            <option value="truncation">Truncation</option>
            <option value="json">JSON parsing</option>
            <option value="api">API errors</option>
            <option value="file">File operations</option>
            <option value="cli">CLI commands</option>
        </select>
        <label>Session Type:</label>
        <select id="sessionTypeFilter" onchange="filterTable()">
            <option value="all">All types</option>
            <option value="single">📦 Single</option>
            <option value="extended">📦 Extended</option>
            <option value="handoff">🔄 Hand-off</option>
        </select>
        <input type="text" id="searchBox" placeholder="Search..." oninput="filterTable()">
        <button id="groupBySession" onclick="toggleGroupBy('session')">Group by Session</button>
        <button id="groupByType" onclick="toggleGroupBy('type')">Group by Type</button>
    </div>
    
    <div class="stats">
        <div class="stat-card bugs" onclick="setTypeFilter('bug')"><div class="number" id="bugCount">-</div><div class="label">Bugs</div></div>
        <div class="stat-card failures" onclick="setTypeFilter('failure')"><div class="number" id="failureCount">-</div><div class="label">Op Failures</div></div>
        <div class="stat-card errors" onclick="setTypeFilter('error')"><div class="number" id="errorCount">-</div><div class="label">Pair Errors</div></div>
        <div class="stat-card cli" onclick="setTypeFilter('cli')"><div class="number" id="cliCount">-</div><div class="label">CLI Failures</div></div>
        <div class="stat-card sessions"><div class="number" id="sessionCount">-</div><div class="label">Sessions w/ Errors</div></div>
    </div>
    
    <!-- Charts Row 1 -->
    <div class="charts-row">
        <div class="chart-card" style="max-width: 250px;">
            <h4>📊 Errors by Type</h4>
            <div id="pieChart" class="chart-container"></div>
        </div>
        <div class="chart-card" style="max-width: 250px;">
            <h4>📦 Session Types</h4>
            <div id="sessionTypePie" class="chart-container"></div>
        </div>
        <div class="chart-card">
            <h4>📈 Errors Over Time (by Type)</h4>
            <div id="stackedBarChart" class="chart-container"></div>
        </div>
        <div class="chart-card">
            <h4>📉 Avg Errors per Session</h4>
            <div id="lineChart" class="chart-container"></div>
        </div>
    </div>
    
    <!-- Charts Row 2 - Token & Session Analysis -->
    <div class="charts-row">
        <div class="chart-card">
            <h4>🔤 Tokens: Request vs Response</h4>
            <div id="tokensChart" class="chart-container"></div>
        </div>
        <div class="chart-card">
            <h4>📦 Avg Session Size (KB)</h4>
            <div id="sessionSizeChart" class="chart-container"></div>
        </div>
    </div>
    
    <table id="errorTable">
        <thead>
            <tr>
                <th>Type</th>
                <th>Category</th>
                <th>Timestamp</th>
                <th>Session</th>
                <th>Description</th>
                <th>Actions</th>
            </tr>
        </thead>
        <tbody id="tableBody">
            <tr><td colspan="6" class="empty">Loading...</td></tr>
        </tbody>
    </table>
    
    <!-- JSON Viewer Modal -->
    <div class="modal-overlay" id="jsonModal">
        <div class="modal">
            <div class="modal-header">
                <h2>Session: <span id="modalSessionId">...</span> | Pair #<span id="modalPairIndex">...</span></h2>
                <button class="modal-close" onclick="closeModal()">&times;</button>
            </div>
            <div class="modal-tabs">
                <div class="modal-tab" data-tab="full" onclick="switchTab('full')">Full JSON</div>
                <div class="modal-tab" data-tab="errors" onclick="switchTab('errors')">Errors Only</div>
                <div class="modal-tab" data-tab="pair" onclick="switchTab('pair')">Error Pair</div>
                <div class="modal-tab ai-tab" data-tab="ai" onclick="switchTab('ai')">🤖 AI Inputs</div>
            </div>
            <div class="modal-body">
                <div id="tabFull" class="json-viewer"></div>
                <div id="tabErrors" class="errors-summary" style="display:none"></div>
                <div id="tabPair" class="json-viewer" style="display:none"></div>
                <div id="tabAi" class="ai-inputs" style="display:none"></div>
            </div>
        </div>
    </div>
    
    <script>
        let allErrors = [];
        let rawData = null;  // Store raw API response for chart filtering
        let groupBy = null;
        let sessionCache = {};
        let currentSession = null;
        let currentPairIndex = 0;
        
        // ECharts instances
        let pieChart, sessionTypePie, stackedBarChart, lineChart, tokensChart, sessionSizeChart;
        
        // Session type lookup cache
        let sessionTypeCache = {};
        
        // Initialize charts
        function initCharts() {
            pieChart = echarts.init(document.getElementById('pieChart'));
            sessionTypePie = echarts.init(document.getElementById('sessionTypePie'));
            stackedBarChart = echarts.init(document.getElementById('stackedBarChart'));
            lineChart = echarts.init(document.getElementById('lineChart'));
            tokensChart = echarts.init(document.getElementById('tokensChart'));
            sessionSizeChart = echarts.init(document.getElementById('sessionSizeChart'));
            
            // Connect charts for synchronized crosshair/tooltip
            echarts.connect([stackedBarChart, lineChart, tokensChart, sessionSizeChart]);
            
            // Handle resize
            window.addEventListener('resize', () => {
                pieChart.resize();
                sessionTypePie.resize();
                stackedBarChart.resize();
                lineChart.resize();
                tokensChart.resize();
                sessionSizeChart.resize();
            });
        }
        
        function updateCharts(data) {
            const timeRange = document.getElementById('timeRange').value;
            
            // Pie Chart - Errors by Type
            const typeCounts = { bug: 0, failure: 0, error: 0 };
            data.errors.forEach(e => { if (typeCounts[e.type] !== undefined) typeCounts[e.type]++; });
            
            pieChart.setOption({
                backgroundColor: 'transparent',
                tooltip: { trigger: 'item', formatter: '{b}: {c} ({d}%)' },
                legend: { orient: 'vertical', left: 'left', textStyle: { color: '#888' } },
                series: [{
                    type: 'pie',
                    radius: ['40%', '70%'],
                    avoidLabelOverlap: false,
                    itemStyle: { borderRadius: 4, borderColor: '#252526', borderWidth: 2 },
                    label: { show: false },
                    emphasis: { label: { show: true, fontSize: 14, fontWeight: 'bold' } },
                    data: [
                        { value: typeCounts.bug, name: 'Bugs', itemStyle: { color: '#f14c4c' } },
                        { value: typeCounts.failure, name: 'Failures', itemStyle: { color: '#cca700' } },
                        { value: typeCounts.error, name: 'Errors', itemStyle: { color: '#cc6633' } }
                    ]
                }]
            });
            
            // Session Type Pie Chart
            // Cache session types for badges
            const sessionTypes = data.sessionTypes || { single: 0, extended: 0, handoff: 0 };
            sessionTypeCache = data.sessionTypeMap || {};
            
            sessionTypePie.setOption({
                backgroundColor: 'transparent',
                tooltip: { trigger: 'item', formatter: '{b}: {c} ({d}%)' },
                legend: { orient: 'vertical', left: 'left', textStyle: { color: '#888' } },
                series: [{
                    type: 'pie',
                    radius: ['40%', '70%'],
                    avoidLabelOverlap: false,
                    itemStyle: { borderRadius: 4, borderColor: '#252526', borderWidth: 2 },
                    label: { show: false },
                    emphasis: { label: { show: true, fontSize: 12, fontWeight: 'bold' } },
                    data: [
                        { value: sessionTypes.single, name: 'Single', itemStyle: { color: '#6ab0de' } },
                        { value: sessionTypes.extended, name: 'Extended', itemStyle: { color: '#deb06a' } },
                        { value: sessionTypes.handoff, name: 'Hand-off', itemStyle: { color: '#b06ade' } }
                    ]
                }]
            });
            
            // Stacked Bar Chart - Errors Over Time by Type
            const timeData = data.timeSeries || [];
            stackedBarChart.setOption({
                backgroundColor: 'transparent',
                tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
                legend: { data: ['Bugs', 'Failures', 'Errors'], textStyle: { color: '#888' }, top: 0 },
                grid: { left: '3%', right: '4%', bottom: '3%', top: '40px', containLabel: true },
                xAxis: { type: 'category', data: timeData.map(t => t.period), axisLabel: { color: '#888' }, axisLine: { lineStyle: { color: '#444' } } },
                yAxis: { type: 'value', axisLabel: { color: '#888' }, axisLine: { lineStyle: { color: '#444' } }, splitLine: { lineStyle: { color: '#333' } } },
                series: [
                    { name: 'Bugs', type: 'bar', stack: 'total', emphasis: { focus: 'series' }, data: timeData.map(t => t.bugs), itemStyle: { color: '#f14c4c' } },
                    { name: 'Failures', type: 'bar', stack: 'total', emphasis: { focus: 'series' }, data: timeData.map(t => t.failures), itemStyle: { color: '#cca700' } },
                    { name: 'Errors', type: 'bar', stack: 'total', emphasis: { focus: 'series' }, data: timeData.map(t => t.errors), itemStyle: { color: '#cc6633' } }
                ]
            });
            
            // Line Chart - Avg Errors per Session
            lineChart.setOption({
                backgroundColor: 'transparent',
                tooltip: { trigger: 'axis' },
                grid: { left: '3%', right: '4%', bottom: '3%', top: '20px', containLabel: true },
                xAxis: { type: 'category', data: timeData.map(t => t.period), axisLabel: { color: '#888' }, axisLine: { lineStyle: { color: '#444' } }, boundaryGap: false },
                yAxis: { type: 'value', name: 'Avg Errors/Session', nameTextStyle: { color: '#888' }, axisLabel: { color: '#888' }, axisLine: { lineStyle: { color: '#444' } }, splitLine: { lineStyle: { color: '#333' } } },
                series: [{
                    name: 'Avg Errors/Session',
                    type: 'line',
                    smooth: true,
                    symbol: 'circle',
                    symbolSize: 8,
                    data: timeData.map(t => t.avgPerSession),
                    lineStyle: { color: '#4ec9b0', width: 3 },
                    itemStyle: { color: '#4ec9b0' },
                    areaStyle: { color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
                        { offset: 0, color: 'rgba(78, 201, 176, 0.4)' },
                        { offset: 1, color: 'rgba(78, 201, 176, 0.05)' }
                    ])}
                }]
            });
            
            // Tokens Chart - Stacked Area (Request vs Response)
            tokensChart.setOption({
                backgroundColor: 'transparent',
                tooltip: { trigger: 'axis', axisPointer: { type: 'cross', label: { backgroundColor: '#333' } } },
                legend: { data: ['Tokens In (Request)', 'Tokens Out (Response)'], textStyle: { color: '#888' }, top: 0 },
                grid: { left: '3%', right: '4%', bottom: '3%', top: '40px', containLabel: true },
                xAxis: { type: 'category', data: timeData.map(t => t.period), axisLabel: { color: '#888' }, axisLine: { lineStyle: { color: '#444' } }, boundaryGap: false },
                yAxis: { type: 'value', name: 'Tokens', nameTextStyle: { color: '#888' }, axisLabel: { color: '#888', formatter: v => v >= 1000 ? (v/1000).toFixed(0) + 'k' : v }, axisLine: { lineStyle: { color: '#444' } }, splitLine: { lineStyle: { color: '#333' } } },
                series: [
                    {
                        name: 'Tokens In (Request)',
                        type: 'line',
                        stack: 'tokens',
                        smooth: true,
                        symbol: 'none',
                        data: timeData.map(t => t.tokensIn || 0),
                        lineStyle: { width: 2, color: '#569cd6' },
                        areaStyle: { color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
                            { offset: 0, color: 'rgba(86, 156, 214, 0.5)' },
                            { offset: 1, color: 'rgba(86, 156, 214, 0.1)' }
                        ])}
                    },
                    {
                        name: 'Tokens Out (Response)',
                        type: 'line',
                        stack: 'tokens',
                        smooth: true,
                        symbol: 'none',
                        data: timeData.map(t => t.tokensOut || 0),
                        lineStyle: { width: 2, color: '#c586c0' },
                        areaStyle: { color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
                            { offset: 0, color: 'rgba(197, 134, 192, 0.5)' },
                            { offset: 1, color: 'rgba(197, 134, 192, 0.1)' }
                        ])}
                    }
                ]
            });
            
            // Session Size Chart - Avg KB per Session
            sessionSizeChart.setOption({
                backgroundColor: 'transparent',
                tooltip: { trigger: 'axis', axisPointer: { type: 'cross', label: { backgroundColor: '#333' } } },
                grid: { left: '3%', right: '4%', bottom: '3%', top: '20px', containLabel: true },
                xAxis: { type: 'category', data: timeData.map(t => t.period), axisLabel: { color: '#888' }, axisLine: { lineStyle: { color: '#444' } }, boundaryGap: false },
                yAxis: { type: 'value', name: 'KB/Session', nameTextStyle: { color: '#888' }, axisLabel: { color: '#888' }, axisLine: { lineStyle: { color: '#444' } }, splitLine: { lineStyle: { color: '#333' } } },
                series: [{
                    name: 'Avg Session Size',
                    type: 'line',
                    smooth: true,
                    symbol: 'circle',
                    symbolSize: 6,
                    data: timeData.map(t => t.avgSessionSizeKB || 0),
                    lineStyle: { color: '#dcdcaa', width: 2 },
                    itemStyle: { color: '#dcdcaa' },
                    areaStyle: { color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
                        { offset: 0, color: 'rgba(220, 220, 170, 0.3)' },
                        { offset: 1, color: 'rgba(220, 220, 170, 0.05)' }
                    ])},
                    markLine: {
                        silent: true,
                        lineStyle: { color: '#f14c4c', type: 'dashed' },
                        data: [{ yAxis: 500, name: '500KB Warning' }],
                        label: { color: '#f14c4c', formatter: '500KB limit' }
                    }
                }]
            });
        }
        
        async function loadData() {
            const timeRange = document.getElementById('timeRange').value;
            const resp = await fetch(`/api/errors?range=${timeRange}`);
            const data = await resp.json();
            
            document.getElementById('bugCount').textContent = data.stats.bugs;
            document.getElementById('failureCount').textContent = data.stats.failures;
            document.getElementById('errorCount').textContent = data.stats.errors;
            document.getElementById('cliCount').textContent = data.stats.cli || 0;
            document.getElementById('sessionCount').textContent = data.stats.uniqueSessions;
            
            allErrors = data.errors;
            rawData = data;  // Store raw data for chart filtering
            updateCharts(data);
            filterTable();
        }
        
        function categorizeError(error) {
            const desc = (error.description || '').toLowerCase();
            if (error.type === 'cli') return 'cli';
            if (desc.includes('truncat')) return 'truncation';
            if (desc.includes('json') || error.bugType === 'JSON') return 'json';
            if (desc.includes('api error') || desc.includes('fetch failed')) return 'api';
            if (error.type === 'failure' || desc.includes('line') || desc.includes('diff')) return 'file';
            return 'other';
        }
        
        function setTypeFilter(type) {
            document.getElementById('typeFilter').value = type;
            filterTable();
        }
        
        function toggleGroupBy(mode) {
            const sessionBtn = document.getElementById('groupBySession');
            const typeBtn = document.getElementById('groupByType');
            
            if (groupBy === mode) {
                groupBy = null;
                sessionBtn.classList.remove('active');
                typeBtn.classList.remove('active');
            } else {
                groupBy = mode;
                sessionBtn.classList.toggle('active', mode === 'session');
                typeBtn.classList.toggle('active', mode === 'type');
            }
            filterTable();
        }
        
        function filterTable() {
            const typeFilter = document.getElementById('typeFilter').value;
            const categoryFilter = document.getElementById('categoryFilter').value;
            const sessionTypeFilter = document.getElementById('sessionTypeFilter').value;
            const search = document.getElementById('searchBox').value.toLowerCase();
            
            let filtered = allErrors.map(e => ({...e, category: categorizeError(e)}));
            
            if (typeFilter === 'bug-user') {
                filtered = filtered.filter(e => e.type === 'bug' && e.reportedBy === 'user');
            } else if (typeFilter !== 'all') {
                filtered = filtered.filter(e => e.type === typeFilter);
            }
            if (categoryFilter !== 'all') filtered = filtered.filter(e => e.category === categoryFilter);
            if (sessionTypeFilter !== 'all') {
                filtered = filtered.filter(e => {
                    const sType = sessionTypeCache[e.sessionId] || 'single';
                    return sType === sessionTypeFilter;
                });
            }
            if (search) {
                filtered = filtered.filter(e => 
                    e.description.toLowerCase().includes(search) ||
                    e.sessionId.toLowerCase().includes(search) ||
                    (e.details && e.details.toLowerCase().includes(search))
                );
            }
            
            // Update charts if session type filter is applied
            if (rawData && sessionTypeFilter !== 'all') {
                // Filter errors for charts
                const chartData = {
                    ...rawData,
                    errors: filtered,
                    // Recalculate session types for the filter (show only selected type)
                    sessionTypes: {
                        single: sessionTypeFilter === 'single' ? rawData.sessionTypes.single : 0,
                        extended: sessionTypeFilter === 'extended' ? rawData.sessionTypes.extended : 0,
                        handoff: sessionTypeFilter === 'handoff' ? rawData.sessionTypes.handoff : 0
                    }
                };
                updateCharts(chartData);
                
                // Update stat cards to reflect filtered data
                const typeCounts = { bug: 0, failure: 0, error: 0 };
                filtered.forEach(e => { if (typeCounts[e.type] !== undefined) typeCounts[e.type]++; });
                document.getElementById('bugCount').textContent = typeCounts.bug;
                document.getElementById('failureCount').textContent = typeCounts.failure;
                document.getElementById('errorCount').textContent = typeCounts.error;
                const uniqueSessions = new Set(filtered.map(e => e.sessionId)).size;
                document.getElementById('sessionCount').textContent = uniqueSessions;
            } else if (rawData) {
                // Reset to full data
                updateCharts(rawData);
                document.getElementById('bugCount').textContent = rawData.stats.bugs;
                document.getElementById('failureCount').textContent = rawData.stats.failures;
                document.getElementById('errorCount').textContent = rawData.stats.errors;
                document.getElementById('sessionCount').textContent = rawData.stats.uniqueSessions;
            }
            
            if (groupBy) renderGroupedTable(filtered);
            else renderTable(filtered);
        }
        
        function renderGroupedTable(errors) {
            const tbody = document.getElementById('tableBody');
            if (errors.length === 0) {
                tbody.innerHTML = '<tr><td colspan="6" class="empty">No errors found 🎉</td></tr>';
                return;
            }
            
            const groups = {};
            errors.forEach(e => {
                const key = groupBy === 'session' ? e.sessionId : e.category;
                if (!groups[key]) groups[key] = [];
                groups[key].push(e);
            });
            
            const sortedKeys = Object.keys(groups).sort((a, b) => groups[b].length - groups[a].length);
            
            let html = '';
            sortedKeys.forEach(key => {
                const groupErrors = groups[key];
                const label = groupBy === 'session' ? `Session: ${key.slice(0, 12)}...` : `Category: ${key.toUpperCase()}`;
                html += `<tr class="group-header"><td colspan="6">${label} (${groupErrors.length} errors)</td></tr>`;
                groupErrors.forEach(e => html += renderErrorRow(e));
            });
            
            tbody.innerHTML = html;
        }
        
        function renderTable(errors) {
            const tbody = document.getElementById('tableBody');
            if (errors.length === 0) {
                tbody.innerHTML = '<tr><td colspan="6" class="empty">No errors found 🎉</td></tr>';
                return;
            }
            tbody.innerHTML = errors.map(e => renderErrorRow(e)).join('');
        }
        
        function getSessionTypeBadge(sessionId) {
            const type = sessionTypeCache[sessionId];
            if (!type || type === 'single') return '';
            if (type === 'extended') return '<span class="session-type-badge session-type-extended">📦 EXT</span>';
            if (type === 'handoff') return '<span class="session-type-badge session-type-handoff">🔄 HO</span>';
            return '';
        }
        
        function renderErrorRow(e) {
            const categoryClass = `category-${e.category}`;
            const userBadge = e.reportedBy === 'user' ? '<span class="user-badge">👤 USER</span>' : '';
            const sessionTypeBadge = getSessionTypeBadge(e.sessionId);
            return `
                <tr data-type="${e.type}" data-session="${e.sessionId}" data-pair="${e.pairIndex}">
                    <td><span class="type-badge type-${e.type}">${e.type.toUpperCase()}</span>${userBadge}</td>
                    <td><span class="type-badge ${categoryClass}">${e.category}</span></td>
                    <td class="timestamp">${formatTime(e.timestamp)}</td>
                    <td><a class="session-link" onclick="viewSession('${e.sessionId}', ${e.pairIndex})">${e.sessionId.slice(0, 8)}...</a>${sessionTypeBadge}</td>
                    <td class="description">${escapeHtml(e.description)}</td>
                    <td>
                        <button class="view-btn" onclick="viewSession('${e.sessionId}', ${e.pairIndex})">View</button>
                    </td>
                </tr>
            `;
        }
        
        function formatTime(ts) {
            if (!ts) return '-';
            const d = new Date(ts);
            return d.toLocaleString();
        }
        
        function escapeHtml(str) {
            if (!str) return '';
            return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        }
        
        async function viewSession(sessionId, pairIndex) {
            currentPairIndex = pairIndex;
            document.getElementById('modalSessionId').textContent = sessionId.slice(0, 12) + '...';
            document.getElementById('modalPairIndex').textContent = pairIndex;
            document.getElementById('jsonModal').classList.add('active');
            
            document.getElementById('tabFull').innerHTML = 'Loading session data...';
            document.getElementById('tabErrors').innerHTML = 'Loading...';
            document.getElementById('tabPair').innerHTML = 'Loading...';
            document.getElementById('tabAi').innerHTML = 'Loading...';
            
            let session = sessionCache[sessionId];
            if (!session) {
                const resp = await fetch(`/api/session/${sessionId}`);
                session = await resp.json();
                sessionCache[sessionId] = session;
            }
            currentSession = session;
            
            if (session.error) {
                document.getElementById('tabFull').innerHTML = `Error: ${session.error}`;
                return;
            }
            
            renderFullJson(session, pairIndex);
            renderErrorsOnly(session);
            renderPair(session, pairIndex);
            renderAiInputs(session, pairIndex);
            
            switchTab('ai');  // Default to AI Inputs tab
        }
        
        function renderFullJson(session, highlightPairIndex) {
            const container = document.getElementById('tabFull');
            const json = JSON.stringify(session, null, 2);
            const lines = json.split('\\n');
            
            let inPair = false, pairDepth = 0, pairCount = -1, highlightStart = -1, highlightEnd = -1;
            
            lines.forEach((line, i) => {
                if (line.includes('"pairs"')) inPair = true;
                if (inPair) {
                    if (line.trim() === '{' || line.includes('": {')) {
                        if (pairDepth === 1) pairCount++;
                        pairDepth++;
                        if (pairCount === highlightPairIndex && highlightStart === -1) highlightStart = i;
                    }
                    if (line.trim().startsWith('}')) {
                        pairDepth--;
                        if (pairCount === highlightPairIndex && pairDepth === 1) highlightEnd = i;
                    }
                }
            });
            
            const html = lines.map((line, i) => {
                const isHighlight = i >= highlightStart && i <= highlightEnd;
                const isContext = (i >= highlightStart - 3 && i < highlightStart) || (i > highlightEnd && i <= highlightEnd + 3);
                const lineClass = isHighlight ? 'highlight' : (isContext ? 'error-context' : '');
                return `<div class="json-line ${lineClass}" id="line-${i}">${i + 1}: ${syntaxHighlight(escapeHtml(line))}</div>`;
            }).join('');
            
            container.innerHTML = html;
            if (highlightStart > 0) {
                setTimeout(() => {
                    const el = document.getElementById(`line-${highlightStart}`);
                    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }, 100);
            }
        }
        
        function renderErrorsOnly(session) {
            const container = document.getElementById('tabErrors');
            let html = '<h3>All Errors in Session</h3>';
            
            if (session.bugs?.length) {
                html += '<h4 style="color:#f14c4c">🐛 Bugs (' + session.bugs.length + ')</h4>';
                session.bugs.forEach((bug, i) => {
                    html += `<div class="error-card"><div class="error-card-header"><span>#${i + 1} - ${bug.type} @ Pair ${bug.pairIndex}</span><button class="copy-btn" onclick="copyToClipboard(this, ${JSON.stringify(JSON.stringify(bug))})">📋 Copy</button></div><div class="error-card-body"><pre>${escapeHtml(JSON.stringify(bug, null, 2))}</pre></div></div>`;
                });
            }
            
            if (session.operationFailures?.length) {
                html += '<h4 style="color:#cca700">⚠️ Operation Failures (' + session.operationFailures.length + ')</h4>';
                session.operationFailures.forEach((f, i) => {
                    html += `<div class="error-card"><div class="error-card-header"><span>#${i + 1} - ${f.operationType} @ ${f.filePath || 'unknown'}</span><button class="copy-btn" onclick="copyToClipboard(this, ${JSON.stringify(JSON.stringify(f))})">📋 Copy</button></div><div class="error-card-body"><pre>${escapeHtml(JSON.stringify(f, null, 2))}</pre></div></div>`;
                });
            }
            
            const errorPairs = (session.pairs || []).filter(p => p.response?.status === 'error');
            if (errorPairs.length) {
                html += '<h4 style="color:#cc6633">❌ Error Pairs (' + errorPairs.length + ')</h4>';
                errorPairs.forEach(p => {
                    const pairIndex = session.pairs.indexOf(p);
                    html += `<div class="error-card"><div class="error-card-header"><span>Pair #${pairIndex} - ${p.response?.errorMessage || 'Unknown error'}</span><button class="copy-btn" onclick="copyToClipboard(this, ${JSON.stringify(JSON.stringify(p))})">📋 Copy</button></div><div class="error-card-body"><pre>${escapeHtml(JSON.stringify(p, null, 2))}</pre></div></div>`;
                });
            }
            
            if (!session.bugs?.length && !session.operationFailures?.length && !errorPairs.length) {
                html += '<p class="empty">No errors found in this session</p>';
            }
            
            container.innerHTML = html;
        }
        
        function renderPair(session, pairIndex) {
            const container = document.getElementById('tabPair');
            const pair = session.pairs?.[pairIndex];
            
            if (!pair) {
                container.innerHTML = `<div class="empty">Pair #${pairIndex} not found</div>`;
                return;
            }
            
            const json = JSON.stringify(pair, null, 2);
            const lines = json.split('\\n');
            
            const html = `<div style="padding: 10px; background: #333; margin-bottom: 10px; display: flex; justify-content: space-between; align-items: center;"><span>Pair #${pairIndex} (${pair.response?.status || 'unknown'} status)</span><button class="copy-btn" onclick="copyToClipboard(this, ${JSON.stringify(json)})">📋 Copy Pair JSON</button></div>` + 
                lines.map((line, i) => {
                    const isError = line.includes('error') || line.includes('Error') || line.includes('failed');
                    return `<div class="json-line ${isError ? 'highlight' : ''}">${i + 1}: ${syntaxHighlight(escapeHtml(line))}</div>`;
                }).join('');
            
            container.innerHTML = html;
        }
        
        function renderAiInputs(session, pairIndex) {
            const container = document.getElementById('tabAi');
            const pair = session.pairs?.[pairIndex];
            
            // Find relevant bug/failure for this pair
            const bug = session.bugs?.find(b => b.pairIndex === pairIndex);
            const failure = session.operationFailures?.find(f => f.pairIndex === pairIndex);
            
            // Build the debug package
            const debugPackage = {
                _instructions: "This is a debug package for analyzing an error in Grok AI Coder VS Code extension. Use this context to help debug the issue.",
                _priority: "Focus on: 1) Why the error occurred, 2) What data was corrupted, 3) How to prevent this",
                
                error_summary: {
                    type: bug?.type || failure?.operationType || 'unknown',
                    description: bug?.description || failure?.error || 'Unknown error',
                    timestamp: bug?.timestamp || failure?.timestamp,
                    pairIndex: pairIndex,
                    sessionId: session.id
                },
                
                user_request: pair?.request?.text?.slice(0, 1000) || 'N/A',
                
                ai_response_raw: pair?.response?.rawText?.slice(0, 2000) || pair?.response?.text?.slice(0, 2000) || 'N/A',
                
                ai_response_parsed: pair?.response?.structured ? {
                    summary: pair.response.structured.summary,
                    hasFileChanges: !!pair.response.structured.fileChanges?.length,
                    fileChangeCount: pair.response.structured.fileChanges?.length || 0,
                    fileChangePaths: pair.response.structured.fileChanges?.map(fc => fc.path) || [],
                    hasTodos: !!pair.response.structured.todos?.length,
                    hasCommands: !!pair.response.structured.commands?.length
                } : 'Not parsed',
                
                file_changes_attempted: pair?.response?.structured?.fileChanges?.map(fc => ({
                    path: fc.path,
                    contentLength: fc.content?.length || 0,
                    isDiff: fc.isDiff || false,
                    hasLineOperations: !!fc.lineOperations?.length,
                    contentPreview: fc.content?.slice(0, 300) || 'N/A'
                })) || [],
                
                bug_report: bug || null,
                
                operation_failure: failure ? {
                    operationType: failure.operationType,
                    filePath: failure.filePath,
                    error: failure.error,
                    fileSnapshot: failure.fileSnapshot,
                    failedOperation: failure.failedOperation,
                    debugContext: failure.debugContext
                } : null,
                
                session_context: {
                    projectName: session.projectName,
                    totalPairs: session.pairs?.length || 0,
                    totalCost: session.cost,
                    tokensIn: session.tokensIn || 0,
                    tokensOut: session.tokensOut || 0,
                    createdAt: session.createdAt,
                    hasChangeHistory: !!session.changeHistory?.history?.length,
                    // Session type info for AI context
                    sessionType: session.extensionInfo?.currentExtension > 1 ? 'extended' : 
                                 (session.parentSessionId || session.handoffToSessionId) ? 'handoff' : 'single',
                    sessionTypeExplanation: {
                        single: 'Normal session with all data in one document',
                        extended: 'Session that grew too large (>15MB) and was split into multiple documents. Check extensionInfo for details.',
                        handoff: 'Session that was continued from or handed off to another session. Check parentSessionId/handoffToSessionId.'
                    },
                    extensionInfo: session.extensionInfo || null,
                    parentSessionId: session.parentSessionId || null,
                    handoffToSessionId: session.handoffToSessionId || null
                }
            };
            
            const packageJson = JSON.stringify(debugPackage, null, 2);
            
            let html = `
                <h3>🤖 AI Debug Inputs</h3>
                
                <div class="ai-inputs-intro">
                    <p><strong>Copy this debug package and paste into your AI assistant.</strong></p>
                    <p>It contains all the context needed to analyze this error.</p>
                    <button class="copy-btn large" onclick="copyToClipboard(this, ${JSON.stringify(packageJson)})">
                        📋 Copy Full Debug Package
                    </button>
                </div>
                
                <div class="debug-section priority-high">
                    <div class="debug-section-header">
                        <span>🚨 Error Summary</span>
                    </div>
                    <div class="debug-section-body">
                        <div class="debug-label">Type</div>
                        <div class="debug-value">${escapeHtml(debugPackage.error_summary.type)}</div>
                        <div class="debug-label">Description</div>
                        <div class="debug-value">${escapeHtml(debugPackage.error_summary.description)}</div>
                    </div>
                </div>
                
                <div class="debug-section priority-high">
                    <div class="debug-section-header">
                        <span>📝 User Request</span>
                        <button class="copy-btn" onclick="copyToClipboard(this, ${JSON.stringify(debugPackage.user_request)})">📋</button>
                    </div>
                    <div class="debug-section-body">
                        <pre>${escapeHtml(debugPackage.user_request)}</pre>
                    </div>
                </div>
                
                <div class="debug-section priority-high">
                    <div class="debug-section-header">
                        <span>🤖 AI Response (Raw)</span>
                        <button class="copy-btn" onclick="copyToClipboard(this, ${JSON.stringify(debugPackage.ai_response_raw)})">📋</button>
                    </div>
                    <div class="debug-section-body">
                        <pre>${escapeHtml(typeof debugPackage.ai_response_raw === 'string' ? debugPackage.ai_response_raw : JSON.stringify(debugPackage.ai_response_raw, null, 2))}</pre>
                    </div>
                </div>
            `;
            
            if (debugPackage.file_changes_attempted.length > 0) {
                html += `
                    <div class="debug-section priority-medium">
                        <div class="debug-section-header">
                            <span>📁 File Changes Attempted (${debugPackage.file_changes_attempted.length})</span>
                        </div>
                        <div class="debug-section-body">
                            <pre>${escapeHtml(JSON.stringify(debugPackage.file_changes_attempted, null, 2))}</pre>
                        </div>
                    </div>
                `;
            }
            
            if (debugPackage.operation_failure) {
                html += `
                    <div class="debug-section priority-high">
                        <div class="debug-section-header">
                            <span>⚠️ Operation Failure Details</span>
                            <button class="copy-btn" onclick="copyToClipboard(this, ${JSON.stringify(JSON.stringify(debugPackage.operation_failure, null, 2))})">📋</button>
                        </div>
                        <div class="debug-section-body">
                            <pre>${escapeHtml(JSON.stringify(debugPackage.operation_failure, null, 2))}</pre>
                        </div>
                    </div>
                `;
            }
            
            html += `
                <div class="debug-section priority-low">
                    <div class="debug-section-header">
                        <span>📊 Full Debug Package (JSON)</span>
                        <button class="copy-btn" onclick="copyToClipboard(this, ${JSON.stringify(packageJson)})">📋</button>
                    </div>
                    <div class="debug-section-body">
                        <pre>${escapeHtml(packageJson)}</pre>
                    </div>
                </div>
            `;
            
            container.innerHTML = html;
        }
        
        function syntaxHighlight(json) {
            return json
                .replace(/"([^"]+)":/g, '<span class="json-key">"$1"</span>:')
                .replace(/: "([^"]*)"/g, ': <span class="json-string">"$1"</span>')
                .replace(/: (\\d+)/g, ': <span class="json-number">$1</span>')
                .replace(/: (true|false)/g, ': <span class="json-boolean">$1</span>')
                .replace(/: (null)/g, ': <span class="json-null">$1</span>');
        }
        
        function switchTab(tabName) {
            document.querySelectorAll('.modal-tab').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.modal-body > div').forEach(d => d.style.display = 'none');
            
            document.querySelector(`.modal-tab[data-tab="${tabName}"]`)?.classList.add('active');
            
            const tabMap = { full: 'tabFull', errors: 'tabErrors', pair: 'tabPair', ai: 'tabAi' };
            document.getElementById(tabMap[tabName]).style.display = 'block';
        }
        
        function closeModal() {
            document.getElementById('jsonModal').classList.remove('active');
        }
        
        function copyToClipboard(btn, text) {
            navigator.clipboard.writeText(text).then(() => {
                const originalText = btn.textContent;
                btn.classList.add('copied');
                btn.textContent = '✓ Copied!';
                setTimeout(() => {
                    btn.classList.remove('copied');
                    btn.textContent = originalText;
                }, 2000);
            });
        }
        
        document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });
        document.getElementById('jsonModal').addEventListener('click', e => {
            if (e.target.classList.contains('modal-overlay')) closeModal();
        });
        
        initCharts();
        loadData();
    </script>
</body>
</html>
"""

@app.route('/')
def dashboard():
    return render_template_string(DASHBOARD_HTML)

@app.route('/api/errors')
def get_errors():
    time_range = request.args.get('range', 'day')
    
    now = datetime.utcnow()
    if time_range == 'hour':
        start = now - timedelta(hours=1)
    elif time_range == 'day':
        start = now - timedelta(days=1)
    elif time_range == 'week':
        start = now - timedelta(days=7)
    elif time_range == 'month':
        start = now - timedelta(days=30)
    else:
        start = datetime(2020, 1, 1)
    
    start_str = start.isoformat() + 'Z'
    
    bugs_query = f"""
        SELECT d.id as sessionId, b.id as bugId, b.type as bugType, b.description, b.timestamp, b.pairIndex, b.debugContext, b.`by` as reportedBy
        FROM `{CB_BUCKET}` d UNNEST d.bugs b
        WHERE d.docType = "chat" AND d.updatedAt >= "{start_str}" AND d.bugs IS NOT MISSING
        ORDER BY b.timestamp DESC
    """
    
    failures_query = f"""
        SELECT d.id as sessionId, f.id as failureId, f.operationType, f.error, f.timestamp, f.filePath, f.pairIndex, f.debugContext
        FROM `{CB_BUCKET}` d UNNEST d.operationFailures f
        WHERE d.docType = "chat" AND d.updatedAt >= "{start_str}" AND d.operationFailures IS NOT MISSING
        ORDER BY f.timestamp DESC
    """
    
    pair_errors_query = f"""
        SELECT d.id as sessionId, ARRAY_POSITION(d.pairs, p) as pairIndex, p.response.status, p.response.errorMessage, p.response.timestamp
        FROM `{CB_BUCKET}` d UNNEST d.pairs p
        WHERE d.docType = "chat" AND d.updatedAt >= "{start_str}" AND p.response.status = "error"
        ORDER BY p.response.timestamp DESC LIMIT 100
    """
    
    # Query for CLI execution failures
    cli_failures_query = f"""
        SELECT d.id as sessionId, c.id as cliId, c.command, c.error, c.timestamp, c.pairIndex, 
               c.cwd, c.durationMs, c.wasAutoExecuted, c.wasWhitelisted, c.exitCode, c.stderr
        FROM `{CB_BUCKET}` d UNNEST d.cliExecutions c
        WHERE d.docType = "chat" AND d.updatedAt >= "{start_str}" AND c.success = false
        ORDER BY c.timestamp DESC
    """
    
    # Query for session stats (tokens, timing, type) for charts
    # Session types: single (no extensions), extended (has extensionInfo), handoff (has parentSessionId or handoffToSessionId)
    session_stats_query = f"""
        SELECT d.id, d.updatedAt, d.tokensIn, d.tokensOut, d.cost,
               d.extensionInfo, d.parentSessionId, d.handoffToSessionId
        FROM `{CB_BUCKET}` d
        WHERE d.docType = "chat" AND d.updatedAt >= "{start_str}"
        ORDER BY d.updatedAt DESC
    """
    
    bugs = query_couchbase(bugs_query)
    failures = query_couchbase(failures_query)
    pair_errors = query_couchbase(pair_errors_query)
    cli_failures = query_couchbase(cli_failures_query)
    session_stats = query_couchbase(session_stats_query)
    
    session_ids = set()
    all_errors = []
    
    for b in bugs:
        session_ids.add(b.get('sessionId', ''))
        all_errors.append({
            'type': 'bug', 'bugType': b.get('bugType', 'unknown'),
            'timestamp': b.get('timestamp', ''), 'sessionId': b.get('sessionId', ''),
            'pairIndex': b.get('pairIndex', 0),
            'description': f"[{b.get('bugType', 'unknown')}] {b.get('description', '')}",
            'details': f"Pair #{b.get('pairIndex', '?')}",
            'debugContext': b.get('debugContext'),
            'reportedBy': b.get('reportedBy', 'script')  # 'user' or 'script'
        })
    
    for f in failures:
        session_ids.add(f.get('sessionId', ''))
        all_errors.append({
            'type': 'failure', 'timestamp': f.get('timestamp', ''),
            'sessionId': f.get('sessionId', ''), 'pairIndex': f.get('pairIndex', 0),
            'description': f"[{f.get('operationType', 'unknown')}] {f.get('filePath', '')}",
            'details': f.get('error', ''),
            'debugContext': f.get('debugContext')
        })
    
    for p in pair_errors:
        session_ids.add(p.get('sessionId', ''))
        all_errors.append({
            'type': 'error', 'timestamp': p.get('timestamp', ''),
            'sessionId': p.get('sessionId', ''), 'pairIndex': p.get('pairIndex', 0),
            'description': p.get('errorMessage', 'Unknown error'),
            'details': f"Pair #{p.get('pairIndex', '?')}"
        })
    
    for c in cli_failures:
        session_ids.add(c.get('sessionId', ''))
        cmd = c.get('command', '')[:50]  # Truncate long commands
        auto_label = '🤖' if c.get('wasAutoExecuted') else '👤'
        all_errors.append({
            'type': 'cli', 'timestamp': c.get('timestamp', ''),
            'sessionId': c.get('sessionId', ''), 'pairIndex': c.get('pairIndex', 0),
            'description': f"[CLI {auto_label}] {cmd}",
            'details': c.get('error', c.get('stderr', '')),
            'command': c.get('command', ''),
            'exitCode': c.get('exitCode'),
            'wasAutoExecuted': c.get('wasAutoExecuted', False),
            'wasWhitelisted': c.get('wasWhitelisted', False)
        })
    
    all_errors.sort(key=lambda x: x['timestamp'], reverse=True)
    
    # Build time series data for charts
    time_series = build_time_series(all_errors, time_range, len(session_ids), session_stats)
    
    # Calculate session types
    # Single: Normal session (no extensions, no handoff)
    # Extended: Session with extensionInfo (split due to size limits)
    # Hand-off: Session with parentSessionId (continued from another) or handoffToSessionId (handed off to another)
    session_types = {'single': 0, 'extended': 0, 'handoff': 0}
    session_type_map = {}  # sessionId -> type
    
    for s in session_stats:
        sid = s.get('id', '')
        if s.get('extensionInfo') and s['extensionInfo'].get('currentExtension', 1) > 1:
            session_types['extended'] += 1
            session_type_map[sid] = 'extended'
        elif s.get('parentSessionId') or s.get('handoffToSessionId'):
            session_types['handoff'] += 1
            session_type_map[sid] = 'handoff'
        else:
            session_types['single'] += 1
            session_type_map[sid] = 'single'
    
    return jsonify({
        'stats': {'bugs': len(bugs), 'failures': len(failures), 'errors': len(pair_errors), 'cli': len(cli_failures), 'uniqueSessions': len(session_ids)},
        'errors': all_errors,
        'timeSeries': time_series,
        'sessionTypes': session_types,
        'sessionTypeMap': session_type_map
    })

@app.route('/api/session/<session_id>')
def get_session(session_id):
    query = f'SELECT d.* FROM `{CB_BUCKET}` d WHERE META(d).id = "{session_id}"'
    results = query_couchbase(query)
    if results:
        return jsonify(results[0])
    return jsonify({'error': 'Session not found'}), 404

if __name__ == '__main__':
    print("=" * 60)
    print("🐛 Error Dashboard v3 for Grok AI Coder")
    print("=" * 60)
    print(f"Couchbase: {CB_HOST}:{CB_PORT} / {CB_BUCKET}")
    print()
    print("NEW: AI Inputs tab - generates debug package for AI assistants")
    print()
    print(f"Open: http://localhost:5050")
    print("=" * 60)
    app.run(host='0.0.0.0', port=5050, debug=True)
