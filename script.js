/**
 * ColdGuard - Professional B2B Equipment Monitoring System
 * Pure Vanilla JavaScript Architecture
 */

(function () {
  'use strict';

  // ==========================================================================
  // CONFIGURATION & PERSISTENCE DEFAULTS
  // ==========================================================================
  const STORAGE_KEYS = {
    SETTINGS: 'coldguard_settings_v1',
    DEVICES: 'coldguard_devices_v1',
    ALERTS: 'coldguard_alerts_v1'
  };

  const DEFAULT_SETTINGS = {
    lowerThreshold: 2.0,
    upperThreshold: 6.0,
    alertDelay: 15,
    pollInterval: 10000,
    simMode: 'normal',
    soundAlerts: false
  };

  const DEFAULT_DEVICES = [
    {
      id: 1,
      name: 'Холодильная камера № 1',
      type: 'fridge',
      typeName: 'Холодильный шкаф (среднетемпературный)',
      location: 'Основной зал • Молочная продукция',
      temp: 3.8,
      minTemp: 2.0,
      maxTemp: 6.0,
      sensorId: '28-FF641E010915',
      lastSeen: new Date().toISOString(),
      status: 'normal',
      isPrimary: true
    },
    {
      id: 2,
      name: 'Морозильный ларь для полуфабрикатов',
      type: 'freezer',
      typeName: 'Морозильный ларь (низкотемпературный)',
      location: 'Склад сырья • Зона заморозки',
      temp: -19.4,
      minTemp: -24.0,
      maxTemp: -18.0,
      sensorId: '28-AA412B980012',
      lastSeen: new Date(Date.now() - 34000).toISOString(),
      status: 'normal',
      isPrimary: false
    },
    {
      id: 3,
      name: 'Кондитерская витрина «Carina»',
      type: 'display',
      typeName: 'Кондитерская витрина (десерты и торты)',
      location: 'Торговый зал • Зона кассы',
      temp: 5.1,
      minTemp: 2.0,
      maxTemp: 8.0,
      sensorId: '28-CC7892110034',
      lastSeen: new Date(Date.now() - 65000).toISOString(),
      status: 'normal',
      isPrimary: false
    }
  ];

  const DEFAULT_ALERTS = [
    {
      id: 'alt-101',
      timestamp: new Date(Date.now() - 4 * 3600 * 1000 - 15 * 60 * 1000).toISOString(),
      deviceId: 1,
      deviceName: 'Холодильная камера № 1',
      recordedTemp: 6.8,
      allowedRange: '+2.0 ... +6.0 °C',
      cause: 'Превышение верхнего предела при плановой выкладке товара',
      severity: 'warning',
      status: 'resolved',
      statusText: 'Устранено',
      resolutionTime: '18 мин'
    },
    {
      id: 'alt-102',
      timestamp: new Date(Date.now() - 11 * 3600 * 1000).toISOString(),
      deviceId: 3,
      deviceName: 'Кондитерская витрина «Carina»',
      recordedTemp: 8.4,
      allowedRange: '+2.0 ... +8.0 °C',
      cause: 'Кратковременный скачок температуры в период интенсивных продаж',
      severity: 'warning',
      status: 'resolved',
      statusText: 'Устранено',
      resolutionTime: '12 мин'
    }
  ];

  // ==========================================================================
  // APPLICATION STATE
  // ==========================================================================
  const state = {
    currentView: 'overview',
    settings: loadSettings(),
    devices: loadDevices(),
    alerts: loadAlerts(),
    chartHours: 24,
    telemetryHistory: [],
    lastTelemetryTime: new Date(),
    pollTimer: null,
    relativeUpdateTimer: null,
    historyPagination: {
      page: 1,
      pageSize: 15
    },
    bridgeStatus: {
      ws: null,
      connected: false,
      arduinoConnected: false,
      port: null,
      mode: 'normal',
      hasReceivedValidTelemetry: false,
      isDemoStream: true,
      lastPacketTime: null,
      reconnectTimeout: null
    },
    isStaticHosting: (typeof window !== 'undefined' && (window.location.protocol === 'https:' || window.location.hostname.endsWith('github.io')))
  };

  function loadSettings() {
    try {
      const saved = localStorage.getItem(STORAGE_KEYS.SETTINGS);
      return saved ? { ...DEFAULT_SETTINGS, ...JSON.parse(saved) } : { ...DEFAULT_SETTINGS };
    } catch (e) {
      console.warn('Could not read settings from storage', e);
      return { ...DEFAULT_SETTINGS };
    }
  }

  function saveSettings(newSettings) {
    state.settings = { ...state.settings, ...newSettings };
    try {
      localStorage.setItem(STORAGE_KEYS.SETTINGS, JSON.stringify(state.settings));
    } catch (e) {
      console.error('Failed to save settings', e);
    }
  }

  function loadDevices() {
    try {
      const saved = localStorage.getItem(STORAGE_KEYS.DEVICES);
      return saved ? JSON.parse(saved) : [...DEFAULT_DEVICES];
    } catch (e) {
      console.warn('Could not read devices from storage', e);
      return [...DEFAULT_DEVICES];
    }
  }

  function saveDevices(devs) {
    state.devices = devs;
    try {
      localStorage.setItem(STORAGE_KEYS.DEVICES, JSON.stringify(devs));
    } catch (e) {
      console.error('Failed to save devices', e);
    }
  }

  function loadAlerts() {
    try {
      const saved = localStorage.getItem(STORAGE_KEYS.ALERTS);
      return saved ? JSON.parse(saved) : [...DEFAULT_ALERTS];
    } catch (e) {
      return [...DEFAULT_ALERTS];
    }
  }

  function saveAlerts(alts) {
    state.alerts = alts;
    try {
      localStorage.setItem(STORAGE_KEYS.ALERTS, JSON.stringify(alts));
    } catch (e) {
      console.error('Failed to save alerts', e);
    }
  }

  // ==========================================================================
  // 24-HOUR REALISTIC TELEMETRY GENERATOR
  // ==========================================================================
  function generateHistoricalTelemetry() {
    const list = [];
    const now = Date.now();
    const primaryDev = state.devices.find(d => d.isPrimary) || state.devices[0];
    const totalPoints = 48; // 30-min intervals over 24 hours
    const intervalMs = (24 * 3600 * 1000) / totalPoints;

    for (let i = totalPoints; i >= 0; i--) {
      const timestamp = new Date(now - i * intervalMs);
      const hoursAgo = i * 0.5;

      // Realistic temperature modeling:
      // Base average ~3.8°C with slow compressor hysteresis cycle
      let temp = 3.8 + Math.sin(i * 0.4) * 0.7;

      // Simulated realistic anomaly 4.5 hours ago (restocking event: +6.6°C)
      if (hoursAgo >= 4.0 && hoursAgo <= 5.0) {
        temp = 6.6 + (Math.random() * 0.3);
      }

      // Defrost cycle 12 hours ago (+5.3°C)
      if (hoursAgo >= 11.5 && hoursAgo <= 12.5) {
        temp = 5.2 + (Math.random() * 0.2);
      }

      // Add slight noise
      temp += (Math.random() - 0.5) * 0.2;
      temp = Math.round(temp * 10) / 10;

      // Determine status based on current settings
      let status = 'normal';
      let note = 'Охлаждение штатное (компрессор активен)';

      if (temp > state.settings.upperThreshold) {
        status = 'warning';
        note = 'Превышение верхнего предела (' + temp + ' °C)';
      } else if (temp < state.settings.lowerThreshold) {
        status = 'warning';
        note = 'Превышение нижнего предела (' + temp + ' °C)';
      }

      list.push({
        id: 'hist-' + i,
        timestamp: timestamp.toISOString(),
        deviceId: primaryDev.id,
        deviceName: primaryDev.name,
        temp: temp,
        minTemp: state.settings.lowerThreshold,
        maxTemp: state.settings.upperThreshold,
        status: status,
        note: note
      });
    }

    state.telemetryHistory = list;
  }

  // ==========================================================================
  // INITIALIZATION
  // ==========================================================================
  document.addEventListener('DOMContentLoaded', () => {
    initApp();
  });

  function initApp() {
    generateHistoricalTelemetry();
    setupNavigation();
    setupModals();
    setupSettingsForm();
    setupFilters();
    setupCsvExport();
    setupWebSerialMock();
    applySimulationMode(state.settings.simMode, false);
    renderAllViews();
    startTelemetryLoop();
    startRelativeTimeUpdater();
    initWebSocketBridge();

    // Responsive window resize for SVG chart
    window.addEventListener('resize', debounce(() => {
      if (state.currentView === 'overview') {
        renderTemperatureChart();
      }
    }, 150));
  }

  // ==========================================================================
  // NAVIGATION & ROUTING
  // ==========================================================================
  function setupNavigation() {
    const navItems = document.querySelectorAll('.sidebar-nav .nav-item');
    const mobileBtn = document.getElementById('mobileMenuBtn');
    const sidebar = document.getElementById('sidebar');

    navItems.forEach(item => {
      item.addEventListener('click', (e) => {
        e.preventDefault();
        const viewName = item.getAttribute('data-view');
        switchView(viewName);
        if (window.innerWidth <= 900) {
          sidebar.classList.remove('mobile-open');
        }
      });
    });

    if (mobileBtn) {
      mobileBtn.addEventListener('click', () => {
        sidebar.classList.toggle('mobile-open');
      });
    }

    // Direct CTA buttons
    const btnGoToSettings = document.getElementById('btnGoToSettings');
    if (btnGoToSettings) {
      btnGoToSettings.addEventListener('click', () => switchView('settings'));
    }

    const btnGoToHistory = document.getElementById('btnGoToHistory');
    if (btnGoToHistory) {
      btnGoToHistory.addEventListener('click', () => switchView('history'));
    }

    // Timeframe selector on chart
    const timeframeBtns = document.querySelectorAll('.timeframe-btn');
    timeframeBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        timeframeBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        state.chartHours = parseInt(btn.getAttribute('data-hours'), 10) || 24;
        renderTemperatureChart();
      });
    });

    // Check hash on load
    const hash = window.location.hash.replace('#', '');
    if (['overview', 'equipment', 'history', 'alerts', 'settings'].includes(hash)) {
      switchView(hash);
    }
  }

  function switchView(viewName) {
    if (!document.getElementById('view-' + viewName)) return;
    state.currentView = viewName;
    window.location.hash = viewName;

    // Update Nav
    document.querySelectorAll('.sidebar-nav .nav-item').forEach(item => {
      if (item.getAttribute('data-view') === viewName) {
        item.classList.add('active');
      } else {
        item.classList.remove('active');
      }
    });

    // Update Page Views
    document.querySelectorAll('.page-view').forEach(view => {
      view.classList.remove('active');
    });
    const target = document.getElementById('view-' + viewName);
    if (target) {
      target.classList.add('active');
    }

    // Update Header Breadcrumb Title
    const titleMap = {
      overview: 'Обзор системы',
      equipment: 'Оборудование',
      history: 'История измерений',
      alerts: 'Предупреждения и инциденты',
      settings: 'Настройки системы'
    };
    const breadcrumb = document.getElementById('headerBreadcrumbTitle');
    if (breadcrumb) {
      breadcrumb.textContent = titleMap[viewName] || 'Обзор системы';
    }

    // Refresh view specific components
    if (viewName === 'overview') {
      renderOverviewKPIs();
      renderTemperatureChart();
      renderRecentEvents();
    } else if (viewName === 'equipment') {
      renderEquipmentTable();
    } else if (viewName === 'history') {
      renderHistoryTable();
    } else if (viewName === 'alerts') {
      renderAlertsView();
    } else if (viewName === 'settings') {
      syncSettingsFormInputs();
    }
  }

  // ==========================================================================
  // RENDER PIPELINE
  // ==========================================================================
  function renderAllViews() {
    updatePrimaryDeviceThresholds();
    renderOverviewKPIs();
    renderTemperatureChart();
    renderRecentEvents();
    renderEquipmentTable();
    renderHistoryTable();
    renderAlertsView();
    updateSidebarAlertBadge();
    updateHardwareStatusUI();
  }

  function updatePrimaryDeviceThresholds() {
    const primary = state.devices.find(d => d.isPrimary) || state.devices[0];
    if (primary) {
      primary.minTemp = state.settings.lowerThreshold;
      primary.maxTemp = state.settings.upperThreshold;
      primary.status = calculateDeviceStatus(primary.temp, primary.minTemp, primary.maxTemp);
    }
  }

  function calculateDeviceStatus(temp, min, max) {
    if (temp > max + 3.0 || temp < min - 3.0) return 'danger';
    if (temp > max || temp < min) return 'warning';
    return 'normal';
  }

  // ==========================================================================
  // OVERVIEW VIEW: KPIS & SPOTLIGHT
  // ==========================================================================
  function renderOverviewKPIs() {
    const primary = state.devices.find(d => d.isPrimary) || state.devices[0];
    if (!primary) return;

    // 1. Current Temp KPI
    const kpiCurrentTemp = document.getElementById('kpiCurrentTemp');
    const kpiTempBadge = document.getElementById('kpiTempBadge');
    const kpiAllowedRange = document.getElementById('kpiAllowedRange');

    if (kpiCurrentTemp) {
      kpiCurrentTemp.textContent = formatTemp(primary.temp);
      kpiCurrentTemp.style.color = getStatusColor(primary.status);
    }

    if (kpiAllowedRange) {
      kpiAllowedRange.textContent = formatTempRange(state.settings.lowerThreshold, state.settings.upperThreshold);
    }

    if (kpiTempBadge) {
      kpiTempBadge.className = 'kpi-badge badge ' + getBadgeClass(primary.status);
      kpiTempBadge.innerHTML = `<span class="badge-dot"></span>${getStatusRussianLabel(primary.status)}`;
    }

    // 2. Active Devices KPI
    const kpiDevicesCount = document.getElementById('kpiDevicesCount');
    if (kpiDevicesCount) {
      kpiDevicesCount.textContent = state.devices.length + ' камеры';
    }

    // 3. Alerts KPI
    const activeAlerts = getActiveAlerts();
    const kpiAlertsVal = document.getElementById('kpiAlertsVal');
    const kpiAlertBadge = document.getElementById('kpiAlertBadge');
    const kpiAlertSubtitle = document.getElementById('kpiAlertSubtitle');

    if (kpiAlertsVal) {
      kpiAlertsVal.textContent = activeAlerts.length;
      kpiAlertsVal.style.color = activeAlerts.length > 0 ? 'var(--status-warning)' : 'var(--status-normal)';
    }

    if (kpiAlertBadge) {
      if (activeAlerts.length === 0) {
        kpiAlertBadge.className = 'kpi-badge badge badge-normal';
        kpiAlertBadge.textContent = 'Все в норме';
      } else {
        kpiAlertBadge.className = 'kpi-badge badge badge-warning';
        kpiAlertBadge.textContent = activeAlerts.length + ' активно';
      }
    }

    if (kpiAlertSubtitle) {
      kpiAlertSubtitle.textContent = activeAlerts.length === 0
        ? 'Отклонений не зафиксировано'
        : `Активно инцидентов: ${activeAlerts.length}`;
    }

    // 4. Timestamp & Device Spotlight Card
    renderLastSeenTimes();

    const spotlightCurrentTemp = document.getElementById('spotlightCurrentTemp');
    const spotlightLimitsText = document.getElementById('spotlightLimitsText');
    const spotlightStatusBadge = document.getElementById('spotlightStatusBadge');
    const chartSubtitleLimits = document.getElementById('chartSubtitleLimits');
    const legendLimitsSpan = document.getElementById('legendLimitsSpan');
    const legendUpperLimit = document.getElementById('legendUpperLimit');
    const legendLowerLimit = document.getElementById('legendLowerLimit');

    if (spotlightCurrentTemp) {
      spotlightCurrentTemp.textContent = formatTemp(primary.temp);
      spotlightCurrentTemp.style.color = getStatusColor(primary.status);
    }

    const rangeStr = formatTempRange(state.settings.lowerThreshold, state.settings.upperThreshold);
    if (spotlightLimitsText) spotlightLimitsText.textContent = rangeStr;
    if (chartSubtitleLimits) chartSubtitleLimits.textContent = rangeStr;
    if (legendLimitsSpan) legendLimitsSpan.textContent = rangeStr;
    if (legendUpperLimit) legendUpperLimit.textContent = formatTemp(state.settings.upperThreshold);
    if (legendLowerLimit) legendLowerLimit.textContent = formatTemp(state.settings.lowerThreshold);

    if (spotlightStatusBadge) {
      spotlightStatusBadge.className = 'badge ' + getBadgeClass(primary.status);
      spotlightStatusBadge.innerHTML = `<span class="badge-dot"></span>${getStatusRussianLabel(primary.status)}`;
    }
  }

  function renderLastSeenTimes() {
    const elapsedSec = Math.max(0, Math.round((Date.now() - state.lastTelemetryTime.getTime()) / 1000));
    const kpiLastTimeAgo = document.getElementById('kpiLastTimeAgo');
    const kpiExactTimestamp = document.getElementById('kpiExactTimestamp');
    const spotlightLastMeasured = document.getElementById('spotlightLastMeasured');
    const headerLastUpdate = document.getElementById('headerLastUpdate');

    const agoText = elapsedSec < 5 ? 'только что' : `${elapsedSec} сек назад`;
    if (kpiLastTimeAgo) kpiLastTimeAgo.textContent = agoText;

    const timeStr = formatTime(state.lastTelemetryTime);
    if (kpiExactTimestamp) kpiExactTimestamp.textContent = `Фиксация: Сегодня, ${timeStr}`;
    if (spotlightLastMeasured) spotlightLastMeasured.textContent = `Сегодня, ${timeStr}`;
    if (headerLastUpdate) headerLastUpdate.textContent = timeStr;
  }

  // ==========================================================================
  // CUSTOM RESPONSIVE SVG TEMPERATURE CHART (Pure Native SVG)
  // ==========================================================================
  function renderTemperatureChart() {
    const svg = document.getElementById('temperatureChartSvg');
    const container = document.getElementById('chartSvgWrapper');
    const tooltip = document.getElementById('chartTooltip');
    const tooltipTime = document.getElementById('tooltipTime');
    const tooltipTemp = document.getElementById('tooltipTemp');

    if (!svg || !container) return;

    const width = container.clientWidth || 800;
    const height = 280;
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);

    // Filter telemetry slice by hours
    const cutoffTime = Date.now() - state.chartHours * 3600 * 1000;
    let dataPoints = state.telemetryHistory.filter(pt => new Date(pt.timestamp).getTime() >= cutoffTime);

    // If slice is too small, fallback to entire history
    if (dataPoints.length < 2) {
      dataPoints = state.telemetryHistory;
    }

    // Chart margins
    const margin = { top: 25, right: 35, bottom: 35, left: 50 };
    const chartW = width - margin.left - margin.right;
    const chartH = height - margin.top - margin.bottom;

    // Y Axis Scale Bounds: Must comfortably encompass thresholds and min/max readings
    const lowerLim = state.settings.lowerThreshold;
    const upperLim = state.settings.upperThreshold;
    const temps = dataPoints.map(d => d.temp);
    const minVal = Math.min(-1.0, lowerLim - 2.0, ...temps);
    const maxVal = Math.max(10.0, upperLim + 3.0, ...temps);

    // Coordinate transforms
    function getX(index) {
      if (dataPoints.length <= 1) return margin.left;
      return margin.left + (index / (dataPoints.length - 1)) * chartW;
    }

    function getY(tempVal) {
      return margin.top + chartH - ((tempVal - minVal) / (maxVal - minVal)) * chartH;
    }

    // Clear previous SVG content while keeping defs
    const defs = svg.querySelector('defs');
    svg.innerHTML = '';
    if (defs) svg.appendChild(defs);

    // 1. Grid Lines & Y-Axis Labels
    const ySteps = 5;
    for (let i = 0; i <= ySteps; i++) {
      const stepVal = minVal + (i / ySteps) * (maxVal - minVal);
      const yPos = getY(stepVal);

      // Grid line
      const line = createSvgElement('line', {
        x1: margin.left,
        y1: yPos,
        x2: width - margin.right,
        y2: yPos,
        class: 'chart-grid-line'
      });
      svg.appendChild(line);

      // Label text
      const text = createSvgElement('text', {
        x: margin.left - 10,
        y: yPos + 4,
        'text-anchor': 'end',
        class: 'chart-axis-text'
      });
      text.textContent = (stepVal >= 0 ? '+' : '') + stepVal.toFixed(1) + '°';
      svg.appendChild(text);
    }

    // 2. Shaded Safe Temperature Zone (Green tinted background band)
    const safeTopY = getY(upperLim);
    const safeBottomY = getY(lowerLim);
    const safeHeight = Math.max(2, safeBottomY - safeTopY);

    const safeZoneRect = createSvgElement('rect', {
      x: margin.left,
      y: safeTopY,
      width: chartW,
      height: safeHeight,
      class: 'chart-safe-zone'
    });
    svg.appendChild(safeZoneRect);

    // 3. Threshold Guide Lines (Upper Limit - Red dashed, Lower Limit - Cyan dashed)
    // Upper Threshold
    const upperThresholdLine = createSvgElement('line', {
      x1: margin.left,
      y1: safeTopY,
      x2: width - margin.right,
      y2: safeTopY,
      class: 'chart-threshold-line upper'
    });
    svg.appendChild(upperThresholdLine);

    const upperThresholdLabel = createSvgElement('text', {
      x: width - margin.right + 6,
      y: safeTopY + 3.5,
      class: 'chart-threshold-label',
      fill: 'var(--status-danger)'
    });
    upperThresholdLabel.textContent = formatTemp(upperLim);
    svg.appendChild(upperThresholdLabel);

    // Lower Threshold
    const lowerThresholdLine = createSvgElement('line', {
      x1: margin.left,
      y1: safeBottomY,
      x2: width - margin.right,
      y2: safeBottomY,
      class: 'chart-threshold-line lower'
    });
    svg.appendChild(lowerThresholdLine);

    const lowerThresholdLabel = createSvgElement('text', {
      x: width - margin.right + 6,
      y: safeBottomY + 3.5,
      class: 'chart-threshold-label',
      fill: 'var(--brand-accent)'
    });
    lowerThresholdLabel.textContent = formatTemp(lowerLim);
    svg.appendChild(lowerThresholdLabel);

    // 4. Area Gradient Fill & Telemetry Curve
    let pathD = '';
    let areaD = '';

    dataPoints.forEach((pt, index) => {
      const cx = getX(index);
      const cy = getY(pt.temp);

      if (index === 0) {
        pathD += `M ${cx} ${cy}`;
        areaD += `M ${cx} ${margin.top + chartH} L ${cx} ${cy}`;
      } else {
        pathD += ` L ${cx} ${cy}`;
        areaD += ` L ${cx} ${cy}`;
      }
    });

    if (dataPoints.length > 0) {
      const lastX = getX(dataPoints.length - 1);
      areaD += ` L ${lastX} ${margin.top + chartH} Z`;

      const areaPath = createSvgElement('path', {
        d: areaD,
        class: 'chart-path-area'
      });
      svg.appendChild(areaPath);

      const linePath = createSvgElement('path', {
        d: pathD,
        class: 'chart-path-line'
      });
      svg.appendChild(linePath);
    }

    // 5. Data Points & Tooltips
    dataPoints.forEach((pt, index) => {
      const cx = getX(index);
      const cy = getY(pt.temp);
      const isBreached = pt.temp > upperLim || pt.temp < lowerLim;

      const circle = createSvgElement('circle', {
        cx: cx,
        cy: cy,
        r: 3.5,
        class: `chart-point ${isBreached ? 'alert-point' : ''}`
      });

      // Hover interactivity
      circle.addEventListener('mouseenter', () => {
        circle.setAttribute('r', '6');
        if (tooltip && tooltipTime && tooltipTemp) {
          tooltipTime.textContent = formatFullDateTime(new Date(pt.timestamp));
          tooltipTemp.textContent = `${formatTemp(pt.temp)} • ${getStatusRussianLabel(pt.status)}`;
          tooltip.style.display = 'block';
          tooltip.style.left = `${cx}px`;
          tooltip.style.top = `${cy}px`;
        }
      });

      circle.addEventListener('mouseleave', () => {
        circle.setAttribute('r', '3.5');
        if (tooltip) {
          tooltip.style.display = 'none';
        }
      });

      svg.appendChild(circle);
    });

    // 6. X-Axis Time Labels
    const numLabels = Math.min(6, dataPoints.length);
    for (let i = 0; i < numLabels; i++) {
      const dataIndex = Math.floor((i / (numLabels - 1)) * (dataPoints.length - 1));
      const pt = dataPoints[dataIndex];
      if (!pt) continue;

      const xPos = getX(dataIndex);
      const text = createSvgElement('text', {
        x: xPos,
        y: height - 10,
        'text-anchor': 'middle',
        class: 'chart-axis-text'
      });
      const d = new Date(pt.timestamp);
      text.textContent = `${padZero(d.getHours())}:${padZero(d.getMinutes())}`;
      svg.appendChild(text);
    }
  }

  function createSvgElement(tag, attrs) {
    const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const key in attrs) {
      el.setAttribute(key, attrs[key]);
    }
    return el;
  }

  // ==========================================================================
  // RECENT EVENTS FEED (Overview View)
  // ==========================================================================
  function renderRecentEvents() {
    const list = document.getElementById('overviewEventsList');
    if (!list) return;

    list.innerHTML = '';
    const sortedAlerts = [...state.alerts].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp)).slice(0, 5);

    if (sortedAlerts.length === 0) {
      list.innerHTML = `
        <div style="text-align:center; padding:24px; color:var(--text-muted); font-size:12.5px;">
          Журнал пуст. Аномалий не зафиксировано.
        </div>
      `;
      return;
    }

    sortedAlerts.forEach(alt => {
      const item = document.createElement('div');
      item.className = 'event-row';

      const iconClass = alt.severity === 'danger' ? 'danger' : (alt.severity === 'warning' ? 'warning' : 'normal');

      item.innerHTML = `
        <div class="event-icon-badge ${iconClass}">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>
            <line x1="12" y1="9" x2="12" y2="13"/>
            <line x1="12" y1="17" x2="12.01" y2="17"/>
          </svg>
        </div>
        <div class="event-content">
          <div class="event-msg">${escapeHtml(alt.cause)}</div>
          <div class="event-meta">
            <span>${escapeHtml(alt.deviceName)}</span>
            <span>•</span>
            <span style="font-family:var(--font-mono); font-weight:600;">${formatTemp(alt.recordedTemp)}</span>
            <span>•</span>
            <span>${formatTimeAgo(new Date(alt.timestamp))}</span>
          </div>
        </div>
        <span class="badge ${alt.status === 'resolved' ? 'badge-normal' : 'badge-warning'}" style="font-size:11px;">
          ${escapeHtml(alt.statusText || 'Требует внимания')}
        </span>
      `;
      list.appendChild(item);
    });
  }

  // ==========================================================================
  // EQUIPMENT VIEW (TABLE & FILTERING)
  // ==========================================================================
  function renderEquipmentTable() {
    const tbody = document.getElementById('equipmentTableBody');
    const totalLabel = document.getElementById('equipmentTotalLabel');
    if (!tbody) return;

    const search = (document.getElementById('equipmentSearchInput')?.value || '').toLowerCase().trim();
    const typeFilter = document.getElementById('equipmentTypeFilter')?.value || 'all';
    const statusFilter = document.getElementById('equipmentStatusFilter')?.value || 'all';

    const filtered = state.devices.filter(dev => {
      const matchSearch = dev.name.toLowerCase().includes(search) || dev.location.toLowerCase().includes(search);
      const matchType = typeFilter === 'all' || dev.type === typeFilter;
      const matchStatus = statusFilter === 'all' || dev.status === statusFilter;
      return matchSearch && matchType && matchStatus;
    });

    if (totalLabel) {
      totalLabel.textContent = `Отображено: ${filtered.length} из ${state.devices.length}`;
    }

    tbody.innerHTML = '';

    if (filtered.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="7" style="text-align:center; padding:32px; color:var(--text-muted);">
            Оборудование по заданным критериям не найдено.
          </td>
        </tr>
      `;
      return;
    }

    filtered.forEach(dev => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>
          <div class="device-name-cell">
            <span class="device-name-primary">${escapeHtml(dev.name)}</span>
            <span class="device-name-sub">${escapeHtml(dev.location)} • S/N: <code>${escapeHtml(dev.sensorId || 'N/A')}</code></span>
          </div>
        </td>
        <td>
          <span style="color:var(--text-secondary); font-size:12.5px;">${escapeHtml(dev.typeName)}</span>
        </td>
        <td>
          <span class="temp-cell-val" style="color:${getStatusColor(dev.status)};">
            ${formatTemp(dev.temp)}
          </span>
        </td>
        <td>
          <span class="range-cell-val">
            ${formatTempRange(dev.minTemp, dev.maxTemp)}
          </span>
        </td>
        <td>
          <span class="badge ${getBadgeClass(dev.status)}">
            <span class="badge-dot"></span>${getStatusRussianLabel(dev.status)}
          </span>
        </td>
        <td>
          <span class="time-cell-val">${formatTimeAgo(new Date(dev.lastSeen))}</span>
        </td>
        <td style="text-align:right;">
          <button class="btn btn-secondary btn-sm btn-edit-device" data-id="${dev.id}">
            Параметры
          </button>
        </td>
      `;

      // Quick action button
      const editBtn = tr.querySelector('.btn-edit-device');
      if (editBtn) {
        editBtn.addEventListener('click', () => {
          switchView('settings');
        });
      }

      tbody.appendChild(tr);
    });
  }

  // ==========================================================================
  // TELEMETRY HISTORY VIEW (TABLE & FILTERING)
  // ==========================================================================
  function renderHistoryTable() {
    const tbody = document.getElementById('historyTableBody');
    const emptyState = document.getElementById('historyEmptyState');
    const countLabel = document.getElementById('historyCountLabel');
    const paginationText = document.getElementById('historyPaginationText');
    const pagination = document.getElementById('historyPagination');
    if (!tbody) return;

    const devFilter = document.getElementById('historyDeviceFilter')?.value || 'all';
    const statusFilter = document.getElementById('historyStatusFilter')?.value || 'all';
    const hoursFilter = parseInt(document.getElementById('historyTimeRangeFilter')?.value || '24', 10);

    const cutoff = Date.now() - hoursFilter * 3600 * 1000;

    let filtered = state.telemetryHistory.filter(item => {
      const matchTime = new Date(item.timestamp).getTime() >= cutoff;
      const matchDev = devFilter === 'all' || String(item.deviceId) === String(devFilter);
      const matchStatus = statusFilter === 'all' || item.status === statusFilter;
      return matchTime && matchDev && matchStatus;
    });

    if (countLabel) {
      countLabel.textContent = `Показано записей: ${filtered.length}`;
    }

    if (filtered.length === 0) {
      tbody.innerHTML = '';
      if (emptyState) emptyState.style.display = 'block';
      if (pagination) pagination.style.display = 'none';
      return;
    }

    if (emptyState) emptyState.style.display = 'none';
    if (pagination) pagination.style.display = 'flex';

    // Pagination slice
    const page = state.historyPagination.page;
    const pageSize = state.historyPagination.pageSize;
    const totalPages = Math.ceil(filtered.length / pageSize) || 1;
    const startIndex = (page - 1) * pageSize;
    const pageItems = filtered.slice(startIndex, startIndex + pageSize);

    if (paginationText) {
      paginationText.textContent = `Записи ${startIndex + 1} - ${Math.min(startIndex + pageSize, filtered.length)} из ${filtered.length}`;
    }

    const prevBtn = document.getElementById('btnPrevPage');
    const nextBtn = document.getElementById('btnNextPage');
    if (prevBtn) prevBtn.disabled = page <= 1;
    if (nextBtn) nextBtn.disabled = page >= totalPages;

    tbody.innerHTML = '';
    pageItems.forEach(row => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>
          <span class="time-cell-val" style="color:var(--text-primary); font-weight:500;">
            ${formatFullDateTime(new Date(row.timestamp))}
          </span>
        </td>
        <td>
          <span style="font-weight:600; color:var(--brand-navy); font-size:12.5px;">
            ${escapeHtml(row.deviceName)}
          </span>
        </td>
        <td>
          <span class="temp-cell-val" style="color:${getStatusColor(row.status)};">
            ${formatTemp(row.temp)}
          </span>
        </td>
        <td>
          <span class="range-cell-val">${formatTempRange(row.minTemp, row.maxTemp)}</span>
        </td>
        <td>
          <span class="badge ${getBadgeClass(row.status)}">
            <span class="badge-dot"></span>${getStatusRussianLabel(row.status)}
          </span>
        </td>
        <td>
          <span style="font-size:12px; color:var(--text-secondary);">${escapeHtml(row.note)}</span>
        </td>
      `;
      tbody.appendChild(tr);
    });
  }

  // ==========================================================================
  // ALERTS VIEW (INCIDENT LOG)
  // ==========================================================================
  function renderAlertsView() {
    const tbody = document.getElementById('alertsTableBody');
    const countCrit = document.getElementById('alertCountCritical');
    const countWarn = document.getElementById('alertCountWarning');
    const countRes = document.getElementById('alertCountResolved');

    if (!tbody) return;

    let crit = 0;
    let warn = 0;
    let res = 0;

    state.alerts.forEach(a => {
      if (a.status === 'resolved') {
        res++;
      } else if (a.severity === 'danger') {
        crit++;
      } else {
        warn++;
      }
    });

    if (countCrit) countCrit.textContent = crit;
    if (countWarn) countWarn.textContent = warn;
    if (countRes) countRes.textContent = res;

    tbody.innerHTML = '';

    if (state.alerts.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="8" style="text-align:center; padding:32px; color:var(--text-muted);">
            Все системы работают штатно. Активных инцидентов нет.
          </td>
        </tr>
      `;
      return;
    }

    // Sort by latest
    const sorted = [...state.alerts].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    sorted.forEach(alt => {
      const tr = document.createElement('tr');
      const isPending = alt.status !== 'resolved';

      tr.innerHTML = `
        <td>
          <span class="time-cell-val" style="font-weight:600;">
            ${formatFullDateTime(new Date(alt.timestamp))}
          </span>
        </td>
        <td>
          <span style="font-weight:600; color:var(--brand-navy); font-size:12.5px;">
            ${escapeHtml(alt.deviceName)}
          </span>
        </td>
        <td>
          <span class="temp-cell-val" style="color:var(--status-${alt.severity});">
            ${formatTemp(alt.recordedTemp)}
          </span>
        </td>
        <td>
          <span class="range-cell-val">${escapeHtml(alt.allowedRange)}</span>
        </td>
        <td>
          <span style="font-size:12.5px; font-weight:500;">${escapeHtml(alt.cause)}</span>
        </td>
        <td>
          <span class="badge ${alt.severity === 'danger' ? 'badge-danger' : 'badge-warning'}">
            ${alt.severity === 'danger' ? 'Критическое' : 'Предупреждение'}
          </span>
        </td>
        <td>
          <span class="badge ${alt.status === 'resolved' ? 'badge-normal' : 'badge-warning'}">
            ${alt.status === 'resolved' ? 'Устранено' : 'Требует внимания'}
          </span>
        </td>
        <td style="text-align:right;">
          ${isPending ? `
            <button class="btn btn-secondary btn-sm btn-ack-alert" data-id="${alt.id}">
              Подтвердить
            </button>
          ` : `
            <span style="font-size:11.5px; color:var(--text-muted);">Квитировано</span>
          `}
        </td>
      `;

      // Acknowledge single alert
      const ackBtn = tr.querySelector('.btn-ack-alert');
      if (ackBtn) {
        ackBtn.addEventListener('click', () => {
          acknowledgeAlert(alt.id);
        });
      }

      tbody.appendChild(tr);
    });

    updateSidebarAlertBadge();
  }

  function getActiveAlerts() {
    return state.alerts.filter(a => a.status !== 'resolved');
  }

  function updateSidebarAlertBadge() {
    const active = getActiveAlerts();
    const badge = document.getElementById('sidebarAlertsCount');
    if (badge) {
      badge.textContent = active.length;
      badge.style.display = active.length > 0 ? 'inline-block' : 'none';
    }
  }

  function acknowledgeAlert(alertId) {
    const alert = state.alerts.find(a => a.id === alertId);
    if (alert) {
      alert.status = 'resolved';
      alert.statusText = 'Устранено (Подтверждено оператором)';
      saveAlerts(state.alerts);
      renderAlertsView();
      renderOverviewKPIs();
      renderRecentEvents();
      showToast('Инцидент успешно квитирован и помечен как отработанный', 'success');
    }
  }

  // ==========================================================================
  // SETTINGS CONTROLLER & VALIDATION
  // ==========================================================================
  function setupSettingsForm() {
    const inputLower = document.getElementById('settingLowerThreshold');
    const inputUpper = document.getElementById('settingUpperThreshold');
    const selectDelay = document.getElementById('settingAlertDelay');
    const selectPoll = document.getElementById('settingPollInterval');
    const btnSave = document.getElementById('btnSaveSettings');
    const btnReset = document.getElementById('btnResetSettings');
    const validationBanner = document.getElementById('settingsValidationBanner');
    const validationMsg = document.getElementById('settingsValidationMsg');

    // Instant validation on input
    function validateThresholds() {
      const lower = parseFloat(inputLower.value);
      const upper = parseFloat(inputUpper.value);

      if (isNaN(lower) || isNaN(upper)) {
        validationBanner.classList.remove('hidden');
        validationMsg.textContent = 'Ошибка валидации: Пороги температуры должны быть числовыми значениями.';
        btnSave.disabled = true;
        return false;
      }

      if (lower >= upper) {
        validationBanner.classList.remove('hidden');
        validationMsg.textContent = 'Ошибка валидации: Нижний порог не может быть выше или равен верхнему!';
        inputLower.style.borderColor = 'var(--status-danger)';
        inputUpper.style.borderColor = 'var(--status-danger)';
        btnSave.disabled = true;
        return false;
      }

      // Valid
      validationBanner.classList.add('hidden');
      inputLower.style.borderColor = '';
      inputUpper.style.borderColor = '';
      btnSave.disabled = false;
      return true;
    }

    if (inputLower) inputLower.addEventListener('input', validateThresholds);
    if (inputUpper) inputUpper.addEventListener('input', validateThresholds);

    if (btnSave) {
      btnSave.addEventListener('click', () => {
        if (!validateThresholds()) return;

        const newSettings = {
          lowerThreshold: parseFloat(inputLower.value),
          upperThreshold: parseFloat(inputUpper.value),
          alertDelay: parseInt(selectDelay.value, 10),
          pollInterval: parseInt(selectPoll.value, 10)
        };

        saveSettings(newSettings);
        updatePrimaryDeviceThresholds();
        renderAllViews();
        restartTelemetryLoop();
        showToast('Настройки температурных порогов успешно сохранены', 'success');
      });
    }

    if (btnReset) {
      btnReset.addEventListener('click', () => {
        if (confirm('Сбросить пороги и настройки до заводских значений?')) {
          saveSettings(DEFAULT_SETTINGS);
          syncSettingsFormInputs();
          updatePrimaryDeviceThresholds();
          renderAllViews();
          restartTelemetryLoop();
          showToast('Настройки сброшены к значениям по умолчанию', 'info');
        }
      });
    }

    // Simulation Preset Buttons
    const simButtons = document.querySelectorAll('.btn-sim');
    simButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        const mode = btn.getAttribute('data-mode');
        applySimulationMode(mode, true);
      });
    });
  }

  function syncSettingsFormInputs() {
    const inputLower = document.getElementById('settingLowerThreshold');
    const inputUpper = document.getElementById('settingUpperThreshold');
    const selectDelay = document.getElementById('settingAlertDelay');
    const selectPoll = document.getElementById('settingPollInterval');

    if (inputLower) inputLower.value = state.settings.lowerThreshold.toFixed(1);
    if (inputUpper) inputUpper.value = state.settings.upperThreshold.toFixed(1);
    if (selectDelay) selectDelay.value = state.settings.alertDelay;
    if (selectPoll) selectPoll.value = state.settings.pollInterval;

    // Validate and update active sim button
    document.querySelectorAll('.btn-sim').forEach(b => {
      if (b.getAttribute('data-mode') === state.settings.simMode) {
        b.classList.add('active');
      } else {
        b.classList.remove('active');
      }
    });
  }

  function applySimulationMode(mode, triggerToast = true) {
    state.settings.simMode = mode;
    saveSettings({ simMode: mode });

    document.querySelectorAll('.btn-sim').forEach(b => {
      if (b.getAttribute('data-mode') === mode) {
        b.classList.add('active');
      } else {
        b.classList.remove('active');
      }
    });

    const primary = state.devices.find(d => d.isPrimary) || state.devices[0];
    if (!primary) return;

    let targetTemp = 3.8;
    let causeMsg = '';
    let severity = 'warning';

    if (mode === 'normal') {
      targetTemp = 3.8;
    } else if (mode === 'warning') {
      targetTemp = 7.2;
      causeMsg = 'Открытие двери: превышение порога +6.0 °C (зафиксировано +7.2 °C)';
      severity = 'warning';
    } else if (mode === 'danger') {
      targetTemp = 11.4;
      causeMsg = 'Критический сбой холодильного агрегата (зафиксировано +11.4 °C)';
      severity = 'danger';
    } else if (mode === 'freeze') {
      targetTemp = -1.2;
      causeMsg = 'Переохлаждение среднетемпературной камеры: риск кристаллизации (-1.2 °C)';
      severity = 'warning';
    }

    primary.temp = targetTemp;
    primary.lastSeen = new Date().toISOString();
    primary.status = calculateDeviceStatus(primary.temp, primary.minTemp, primary.maxTemp);
    state.lastTelemetryTime = new Date();

    // If an anomaly is triggered, add to alerts log if not already recent
    if (mode !== 'normal') {
      const newAlert = {
        id: 'alt-' + Date.now(),
        timestamp: new Date().toISOString(),
        deviceId: primary.id,
        deviceName: primary.name,
        recordedTemp: targetTemp,
        allowedRange: formatTempRange(state.settings.lowerThreshold, state.settings.upperThreshold),
        cause: causeMsg,
        severity: severity,
        status: 'pending',
        statusText: 'Требует внимания'
      };
      state.alerts.unshift(newAlert);
      saveAlerts(state.alerts);
    }

    // Add immediate point to telemetry history
    addTelemetryPoint(primary.temp, mode !== 'normal' ? causeMsg : 'Охлаждение в штатном режиме');

    renderAllViews();

    if (triggerToast) {
      if (mode === 'normal') {
        showToast('Симуляция: Восстановлен штатный температурный режим (+3.8 °C)', 'success');
      } else if (mode === 'warning') {
        showToast('Симуляция: Предупреждение о повышении температуры (+7.2 °C)', 'warning');
      } else if (mode === 'danger') {
        showToast('Симуляция: КРИТИЧЕСКИЙ СБОЙ КОМПРЕССОРА (+11.4 °C)', 'danger');
      } else if (mode === 'freeze') {
        showToast('Симуляция: Риск переморозки продукции (-1.2 °C)', 'warning');
      }
    }
  }

  // ==========================================================================
  // REAL-TIME TELEMETRY ENGINE & LOOP
  // ==========================================================================
  function startTelemetryLoop() {
    if (state.pollTimer) clearInterval(state.pollTimer);

    // Если поступает активный поток от WebSocket-моста, внутренний генератор не запускается
    if (state.bridgeStatus && state.bridgeStatus.connected && state.bridgeStatus.hasReceivedValidTelemetry) {
      return;
    }

    state.pollTimer = setInterval(() => {
      runTelemetryPoll();
    }, state.settings.pollInterval || 10000);
  }

  function restartTelemetryLoop() {
    startTelemetryLoop();
  }

  function runTelemetryPoll() {
    // Пропускаем эмуляцию, если активен WebSocket-поток моста
    if (state.bridgeStatus && state.bridgeStatus.connected && state.bridgeStatus.hasReceivedValidTelemetry) {
      return;
    }

    const primary = state.devices.find(d => d.isPrimary) || state.devices[0];
    if (!primary) return;

    // Small realistic micro-variation based on current sim mode
    const mode = state.settings.simMode;
    let base = primary.temp;

    if (mode === 'normal') {
      // Natural cycle around 3.8
      const delta = (Math.random() - 0.5) * 0.2;
      base = Math.max(3.1, Math.min(4.5, base + delta));
    } else {
      // Small jitter around target
      base += (Math.random() - 0.5) * 0.15;
    }

    primary.temp = Math.round(base * 10) / 10;
    primary.lastSeen = new Date().toISOString();
    primary.status = calculateDeviceStatus(primary.temp, primary.minTemp, primary.maxTemp);
    state.lastTelemetryTime = new Date();

    addTelemetryPoint(primary.temp, 'Телеметрия DS18B20 (эмуляция)');

    renderOverviewKPIs();
    renderTemperatureChart();
    renderEquipmentTable();
    renderHistoryTable();
  }

  function addTelemetryPoint(tempVal, note) {
    const primary = state.devices.find(d => d.isPrimary) || state.devices[0];
    const status = calculateDeviceStatus(tempVal, state.settings.lowerThreshold, state.settings.upperThreshold);

    const newPoint = {
      id: 'hist-' + Date.now(),
      timestamp: new Date().toISOString(),
      deviceId: primary.id,
      deviceName: primary.name,
      temp: tempVal,
      minTemp: state.settings.lowerThreshold,
      maxTemp: state.settings.upperThreshold,
      status: status,
      note: note
    };

    state.telemetryHistory.push(newPoint);

    // Keep history capped to last 150 points for optimal browser memory
    if (state.telemetryHistory.length > 150) {
      state.telemetryHistory.shift();
    }
  }

  function startRelativeTimeUpdater() {
    if (state.relativeUpdateTimer) clearInterval(state.relativeUpdateTimer);

    state.relativeUpdateTimer = setInterval(() => {
      renderLastSeenTimes();
    }, 1000);
  }

  // ==========================================================================
  // MODALS & DIALOGS
  // ==========================================================================
  function setupModals() {
    // 1. Arduino Modal
    const arduinoModal = document.getElementById('arduinoModal');
    const btnSidebarConnect = document.getElementById('btnSidebarConnect');
    const btnHeaderConnect = document.getElementById('btnHeaderConnect');
    const btnCloseArduinoModal = document.getElementById('btnCloseArduinoModal');
    const btnConfirmArduinoModal = document.getElementById('btnConfirmArduinoModal');

    function openArduinoModal() {
      if (arduinoModal) arduinoModal.classList.add('open');
    }

    function closeArduinoModal() {
      if (arduinoModal) arduinoModal.classList.remove('open');
    }

    if (btnSidebarConnect) btnSidebarConnect.addEventListener('click', openArduinoModal);
    if (btnHeaderConnect) btnHeaderConnect.addEventListener('click', openArduinoModal);
    if (btnCloseArduinoModal) btnCloseArduinoModal.addEventListener('click', closeArduinoModal);
    if (btnConfirmArduinoModal) btnConfirmArduinoModal.addEventListener('click', closeArduinoModal);

    // 2. Add Device Modal
    const addDeviceModal = document.getElementById('addDeviceModal');
    const btnAddDeviceModal = document.getElementById('btnAddDeviceModal');
    const btnCloseDeviceModal = document.getElementById('btnCloseDeviceModal');
    const btnCancelDeviceModal = document.getElementById('btnCancelDeviceModal');
    const addDeviceForm = document.getElementById('addDeviceForm');

    function openAddDeviceModal() {
      if (addDeviceModal) addDeviceModal.classList.add('open');
    }

    function closeAddDeviceModal() {
      if (addDeviceModal) addDeviceModal.classList.remove('open');
      if (addDeviceForm) addDeviceForm.reset();
    }

    if (btnAddDeviceModal) btnAddDeviceModal.addEventListener('click', openAddDeviceModal);
    if (btnCloseDeviceModal) btnCloseDeviceModal.addEventListener('click', closeAddDeviceModal);
    if (btnCancelDeviceModal) btnCancelDeviceModal.addEventListener('click', closeAddDeviceModal);

    if (addDeviceForm) {
      addDeviceForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const name = document.getElementById('newDeviceName')?.value.trim();
        const type = document.getElementById('newDeviceType')?.value;
        const location = document.getElementById('newDeviceLocation')?.value.trim() || 'Основное помещение';
        const minTemp = parseFloat(document.getElementById('newDeviceMinTemp')?.value);
        const maxTemp = parseFloat(document.getElementById('newDeviceMaxTemp')?.value);
        const sensorId = document.getElementById('newDeviceSensorId')?.value.trim() || `28-FF${Math.floor(100000 + Math.random() * 900000)}`;

        if (!name || isNaN(minTemp) || isNaN(maxTemp)) {
          showToast('Пожалуйста, заполните обязательные поля корректно', 'warning');
          return;
        }

        if (minTemp >= maxTemp) {
          showToast('Нижний порог должен быть меньше верхнего порога', 'danger');
          return;
        }

        const typeLabels = {
          fridge: 'Холодильный шкаф',
          freezer: 'Морозильный ларь',
          display: 'Кондитерская витрина'
        };

        const newDev = {
          id: Date.now(),
          name: name,
          type: type,
          typeName: typeLabels[type] || 'Холодильное оборудование',
          location: location,
          temp: type === 'freezer' ? -20.0 : 4.0,
          minTemp: minTemp,
          maxTemp: maxTemp,
          sensorId: sensorId,
          lastSeen: new Date().toISOString(),
          status: 'normal',
          isPrimary: false
        };

        state.devices.push(newDev);
        saveDevices(state.devices);
        renderEquipmentTable();
        renderOverviewKPIs();
        closeAddDeviceModal();
        showToast(`Оборудование «${name}» успешно добавлено в реестр`, 'success');
      });
    }

    // Close modal on click outside backdrop
    document.querySelectorAll('.modal-overlay').forEach(overlay => {
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) {
          overlay.classList.remove('open');
        }
      });
    });
  }

  // ==========================================================================
  // WEBSOCKET BRIDGE CLIENT (Python bridge on ws://127.0.0.1:8765)
  // ==========================================================================
  function initWebSocketBridge() {
    if (state.bridgeStatus.ws) {
      try {
        state.bridgeStatus.ws.close();
      } catch (e) {}
      state.bridgeStatus.ws = null;
    }

    // На статическом HTTPS-хостинге (например, GitHub Pages) браузер блокирует небезопасные
    // WebSocket-соединения (ws://127.0.0.1) по правилам Mixed Content.
    // В этом случае остаёмся в чистом демонстрационном режиме для жюри без спама ошибок в консоль.
    if (state.isStaticHosting) {
      console.info(
        '[ColdGuard] Веб-панель открыта по защищенному протоколу HTTPS (статический хостинг GitHub Pages). ' +
        'Активен автономный демонстрационный режим для жюри без подключения к локальному COM-порту.'
      );
      updateHardwareStatusUI();
      return;
    }

    const wsUrl = 'ws://127.0.0.1:8765';
    let socket;
    try {
      socket = new WebSocket(wsUrl);
    } catch (err) {
      console.warn('[ColdGuard Bridge] Не удалось инициализировать WebSocket:', err);
      scheduleBridgeReconnect();
      return;
    }

    state.bridgeStatus.ws = socket;

    socket.onopen = () => {
      console.log('[ColdGuard Bridge] Успешное подключение к мосту ws://127.0.0.1:8765');
      state.bridgeStatus.connected = true;
      updateHardwareStatusUI();
    };

    socket.onmessage = (event) => {
      let data;
      try {
        data = JSON.parse(event.data);
      } catch (err) {
        console.warn('[ColdGuard Bridge] Ошибка разбора пакета JSON:', event.data);
        return;
      }

      handleBridgeMessage(data);
    };

    socket.onerror = () => {
      state.bridgeStatus.connected = false;
      updateHardwareStatusUI();
    };

    socket.onclose = () => {
      state.bridgeStatus.connected = false;
      state.bridgeStatus.arduinoConnected = false;
      state.bridgeStatus.ws = null;
      updateHardwareStatusUI();
      scheduleBridgeReconnect();
    };
  }

  function scheduleBridgeReconnect() {
    if (state.bridgeStatus.reconnectTimeout) {
      clearTimeout(state.bridgeStatus.reconnectTimeout);
    }
    state.bridgeStatus.reconnectTimeout = setTimeout(() => {
      initWebSocketBridge();
    }, 4000);
  }

  function handleBridgeMessage(data) {
    if (!data || typeof data !== 'object') return;

    // 1. Статус моста
    if (data.type === 'bridge_status') {
      state.bridgeStatus.arduinoConnected = Boolean(data.arduino_connected);
      state.bridgeStatus.port = data.port || null;
      state.bridgeStatus.mode = data.mode || 'normal';
      updateHardwareStatusUI();
      return;
    }

    // 2. Ошибка датчика от моста
    if (data.type === 'sensor_error') {
      const errMsg = data.error || 'Сбой 1-Wire датчика';
      showToast(`Ошибка оборудования: ${errMsg}`, 'danger');
      return;
    }

    // 3. Пакет телеметрии
    if (data.type === 'telemetry') {
      if (typeof data.temp !== 'number' || isNaN(data.temp)) {
        console.warn('[ColdGuard Bridge] Пакет телеметрии без валидной температуры:', data);
        return;
      }

      const isFirstPacket = !state.bridgeStatus.hasReceivedValidTelemetry;
      state.bridgeStatus.hasReceivedValidTelemetry = true;
      state.bridgeStatus.lastPacketTime = new Date();
      state.bridgeStatus.isDemoStream = Boolean(data.is_demo);
      if (data.port) state.bridgeStatus.port = data.port;

      // При получении первого валидного измерения отключаем встроенный случайный генератор
      if (state.pollTimer) {
        clearInterval(state.pollTimer);
        state.pollTimer = null;
        console.log('[ColdGuard Bridge] Встроенный демогенератор остановлен: активен поток с моста.');
      }

      const primary = state.devices.find(d => d.isPrimary) || state.devices[0];
      if (primary) {
        primary.temp = data.temp;
        primary.lastSeen = data.timestamp || new Date().toISOString();
        primary.status = calculateDeviceStatus(primary.temp, primary.minTemp, primary.maxTemp);
        state.lastTelemetryTime = new Date();

        // Проверяем превышение порогов и формируем инцидент, если порог нарушен
        if (primary.status !== 'normal') {
          const isWarning = primary.status === 'warning';
          const cause = isWarning
            ? `Превышение порога (${formatTemp(primary.temp)} при норме ${formatTempRange(primary.minTemp, primary.maxTemp)})`
            : `Критическое отклонение температуры (${formatTemp(primary.temp)})`;

          const existing = state.alerts.find(a => a.status !== 'resolved' && a.deviceId === primary.id);
          if (!existing) {
            const newAlert = {
              id: 'alt-' + Date.now(),
              timestamp: new Date().toISOString(),
              deviceId: primary.id,
              deviceName: primary.name,
              recordedTemp: primary.temp,
              allowedRange: formatTempRange(primary.minTemp, primary.maxTemp),
              cause: cause,
              severity: primary.status,
              status: 'pending',
              statusText: 'Требует внимания'
            };
            state.alerts.unshift(newAlert);
            saveAlerts(state.alerts);
            renderAlertsView();
          }
        }
      }

      const noteText = data.is_demo
        ? (data.note || 'Тестовый пакет от Python-моста (--demo)')
        : `DS18B20 (COM-мост ${state.bridgeStatus.port || 'USB'})`;

      addTelemetryPoint(data.temp, noteText);

      renderOverviewKPIs();
      renderTemperatureChart();
      renderEquipmentTable();
      renderHistoryTable();
      updateHardwareStatusUI();

      if (isFirstPacket) {
        if (data.is_demo) {
          showToast('WebSocket-мост подключен в тестовом режиме (--demo)', 'info');
        } else {
          showToast(`Установлена связь с Arduino (${state.bridgeStatus.port || 'COM-порт'})! Поток телеметрии активен.`, 'success');
        }
      }
    }
  }

  function updateHardwareStatusUI() {
    const sidebarDot = document.getElementById('sidebarDot');
    const sidebarDemoPill = document.getElementById('sidebarDemoPill');
    const sidebarStatusText = document.getElementById('sidebarStatusText');
    const telemetryStatusLabel = document.getElementById('telemetryStatusLabel');
    const overviewWatermarkTag = document.getElementById('overviewWatermarkTag');
    const modalStatusText = document.getElementById('modalHardwareStatusText');
    const spotlightSensorDesc = document.getElementById('spotlightSensorDesc');

    const isConnected = state.bridgeStatus.connected;
    const hasData = state.bridgeStatus.hasReceivedValidTelemetry;
    const isDemo = state.bridgeStatus.isDemoStream;
    const port = state.bridgeStatus.port;
    const isStatic = state.isStaticHosting;

    // Состояние 1: WebSocket-мост не запущен или недоступен (включая статический хостинг GitHub Pages)
    if (!isConnected) {
      if (sidebarDot) {
        sidebarDot.className = 'status-dot disconnected';
      }
      if (sidebarDemoPill) {
        sidebarDemoPill.textContent = isStatic ? 'Демо (GitHub Pages)' : 'Демо-режим';
        sidebarDemoPill.title = isStatic
          ? 'Статический хостинг GitHub Pages. Включён безопасный демонстрационный режим для жюри.'
          : 'Мост не подключен. Работает автономный демонстрационный режим.';
        sidebarDemoPill.style.backgroundColor = '';
        sidebarDemoPill.style.color = '';
        sidebarDemoPill.style.borderColor = '';
      }
      if (sidebarStatusText) {
        if (isStatic) {
          sidebarStatusText.textContent = 'Режим онлайн-демонстрации (GitHub Pages). Отображаются смоделированные данные. Физический датчик DS18B20 отключен.';
        } else {
          sidebarStatusText.textContent = hasData
            ? 'Связь с мостом потеряна (ws://127.0.0.1:8765). Ожидание восстановления...'
            : 'Физический COM-мост не подключен. Отображаются тестовые данные.';
        }
      }
      if (telemetryStatusLabel) {
        if (isStatic) {
          telemetryStatusLabel.textContent = 'Демо-режим (GitHub Pages)';
        } else {
          telemetryStatusLabel.textContent = hasData ? 'Мост отключён' : 'Демо-поток активен';
        }
      }
      if (overviewWatermarkTag) {
        overviewWatermarkTag.innerHTML = `
          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5">
            <circle cx="12" cy="12" r="10"/>
            <line x1="12" y1="16" x2="12" y2="12"/>
            <line x1="12" y1="8" x2="12.01" y2="8"/>
          </svg>
          ${isStatic ? 'ДЕМО-РЕЖИМ (Static Web)' : 'ДЕМО-РЕЖИМ'}
        `;
        overviewWatermarkTag.title = 'Демонстрационные показания. Физический датчик не подключен.';
        overviewWatermarkTag.style.backgroundColor = '';
        overviewWatermarkTag.style.color = '';
        overviewWatermarkTag.style.borderColor = '';
      }
      if (modalStatusText) {
        if (isStatic) {
          modalStatusText.innerHTML = `
            <strong>Статус: Режим онлайн-демонстрации (GitHub Pages)</strong><br>
            Веб-панель открыта на статическом хостинге. Включён безопасный демонстрационный режим со всеми интерактивными функциями (графики, сценарии аварий, фильтрация, CSV-экспорт). Для приёма данных с реальной платы Arduino Uno R3 запустите проект локально по инструкции ниже.
          `;
        } else {
          modalStatusText.innerHTML = `
            <strong>Статус: Физический датчик не подключен</strong><br>
            В настоящее время активен <em>демонстрационный генератор телеметрии</em>. Для перехода на реальные измерения выполните шаги ниже.
          `;
        }
      }
      if (spotlightSensorDesc) {
        spotlightSensorDesc.innerHTML = 'Датчик: <code>DS18B20 #28-FF641E</code> (1-Wire • демо-моделирование)';
      }
      return;
    }

    // Состояние 2: Мост подключен по WS, но замеры еще не поступили
    if (!hasData) {
      if (sidebarDot) {
        sidebarDot.className = 'status-dot disconnected';
      }
      if (sidebarDemoPill) {
        sidebarDemoPill.textContent = 'Мост онлайн';
        sidebarDemoPill.title = 'WebSocket мост подключен. Ожидание первого измерения.';
        sidebarDemoPill.style.backgroundColor = 'var(--status-warning-bg)';
        sidebarDemoPill.style.color = 'var(--status-warning-text)';
        sidebarDemoPill.style.borderColor = 'var(--status-warning-border)';
      }
      if (sidebarStatusText) {
        sidebarStatusText.textContent = state.bridgeStatus.arduinoConnected
          ? `Arduino обнаружена (${port || 'COM'}). Ожидание первого замера...`
          : 'Мост активен (ws://127.0.0.1:8765). Ожидание подключения Arduino...';
      }
      if (telemetryStatusLabel) {
        telemetryStatusLabel.textContent = 'Мост онлайн (ожидание данных)';
      }
      if (overviewWatermarkTag) {
        overviewWatermarkTag.innerHTML = `
          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5">
            <circle cx="12" cy="12" r="10"/>
            <line x1="12" y1="16" x2="12" y2="12"/>
            <line x1="12" y1="8" x2="12.01" y2="8"/>
          </svg>
          ОЖИДАНИЕ ДАННЫХ
        `;
        overviewWatermarkTag.style.backgroundColor = 'var(--status-warning-bg)';
        overviewWatermarkTag.style.color = 'var(--status-warning-text)';
        overviewWatermarkTag.style.borderColor = 'var(--status-warning-border)';
      }
      if (modalStatusText) {
        modalStatusText.innerHTML = `
          <strong>Статус: WebSocket-мост подключен</strong><br>
          Ожидание поступления первых пакетов телеметрии от Arduino.
        `;
      }
      if (spotlightSensorDesc) {
        spotlightSensorDesc.innerHTML = 'Датчик: <code>DS18B20</code> (Ожидание пакетов)';
      }
      return;
    }

    // Состояние 3: Получены данные от моста в режиме --demo
    if (isDemo) {
      if (sidebarDot) {
        sidebarDot.className = 'status-dot connected';
      }
      if (sidebarDemoPill) {
        sidebarDemoPill.textContent = 'Тест моста';
        sidebarDemoPill.title = 'Активен тестовый режим Python-моста (--demo).';
        sidebarDemoPill.style.backgroundColor = 'var(--status-demo-bg)';
        sidebarDemoPill.style.color = 'var(--status-demo)';
        sidebarDemoPill.style.borderColor = 'var(--status-demo-border)';
      }
      if (sidebarStatusText) {
        sidebarStatusText.textContent = 'Поток от Python-моста в тестовом режиме (--demo).';
      }
      if (telemetryStatusLabel) {
        telemetryStatusLabel.textContent = 'Тестовый поток (WebSocket)';
      }
      if (overviewWatermarkTag) {
        overviewWatermarkTag.innerHTML = `
          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5">
            <circle cx="12" cy="12" r="10"/>
            <line x1="12" y1="16" x2="12" y2="12"/>
            <line x1="12" y1="8" x2="12.01" y2="8"/>
          </svg>
          ДЕМО-МОСТ (--demo)
        `;
        overviewWatermarkTag.style.backgroundColor = 'var(--status-demo-bg)';
        overviewWatermarkTag.style.color = 'var(--status-demo)';
        overviewWatermarkTag.style.borderColor = 'var(--status-demo-border)';
      }
      if (modalStatusText) {
        modalStatusText.innerHTML = `
          <strong>Статус: Активен тестовый режим Python-моста (--demo)</strong><br>
          Пакеты поступают через локальный WebSocket ws://127.0.0.1:8765 без физического COM-порта.
        `;
      }
      if (spotlightSensorDesc) {
        spotlightSensorDesc.innerHTML = 'Датчик: <code>DS18B20 #28-FF641E</code> (1-Wire • эмуляция через мост)';
      }
      return;
    }

    // Состояние 4: Получены реальные данные от физической платы Arduino
    if (sidebarDot) {
      sidebarDot.className = 'status-dot connected';
    }
    if (sidebarDemoPill) {
      sidebarDemoPill.textContent = 'ОНЛАЙН';
      sidebarDemoPill.title = 'Физический датчик DS18B20 онлайн.';
      sidebarDemoPill.style.backgroundColor = 'var(--status-normal-bg)';
      sidebarDemoPill.style.color = 'var(--status-normal-text)';
      sidebarDemoPill.style.borderColor = 'var(--status-normal-border)';
    }
    if (sidebarStatusText) {
      sidebarStatusText.textContent = `Датчик DS18B20 активен на порту ${port || 'COM'}. Передача 1-Wire в норме.`;
    }
    if (telemetryStatusLabel) {
      telemetryStatusLabel.textContent = `DS18B20 Онлайн (${port || 'USB'})`;
    }
    if (overviewWatermarkTag) {
      overviewWatermarkTag.innerHTML = `
        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5">
          <polyline points="20 6 9 17 4 12"/>
        </svg>
        АППАРАТНЫЙ ПОТОК
      `;
      overviewWatermarkTag.style.backgroundColor = 'var(--status-normal-bg)';
      overviewWatermarkTag.style.color = 'var(--status-normal-text)';
      overviewWatermarkTag.style.borderColor = 'var(--status-normal-border)';
    }
    if (modalStatusText) {
      modalStatusText.innerHTML = `
        <strong>Статус: Физический датчик подключен и активен</strong><br>
        Получены реальные замеры температуры от датчика DS18B20 через порт ${port || 'COM'}.
      `;
    }
    if (spotlightSensorDesc) {
      spotlightSensorDesc.innerHTML = `Датчик: <code>DS18B20 #${port || '28-FF641E'}</code> (Аппаратный 1-Wire • Онлайн)`;
    }
  }

  // ==========================================================================
  // ARDUINO WEB SERIAL PROBE & INTEGRATION INFO
  // ==========================================================================
  function setupWebSerialMock() {
    const btnTest = document.getElementById('btnTestWebSerial');
    if (!btnTest) return;

    btnTest.addEventListener('click', () => {
      const hostingNote = state.isStaticHosting
        ? 'Вы просматриваете панель на статическом хостинге GitHub Pages. Здесь активен безопасный режим демонстрации для жюри.\n\n'
        : '';

      alert(
        'Информация об интеграции оборудования:\n\n' +
        hostingNote +
        '1. Основной способ: Локальный Python-мост\n' +
        '   Запускается на компьютере (python bridge/serial_bridge.py) и непрерывно передает\n' +
        '   показания через WebSocket (ws://127.0.0.1:8765) даже в фоновом режиме 24/7.\n\n' +
        '2. Web Serial API: Прямой захват COM-порта браузером НЕ используется,\n' +
        '   так как он блокирует порт для других процессов и прерывается при закрытии вкладки.\n\n' +
        '3. Проверка без датчика:\n' +
        '   Запустите мост в тестовом режиме: python bridge/serial_bridge.py --demo\n' +
        '   и сайт сразу начнет принимать тестовые пакеты через WebSocket.'
      );
    });
  }

  // ==========================================================================
  // FILTERS & SEARCH
  // ==========================================================================
  function setupFilters() {
    // Equipment filters
    const eqSearch = document.getElementById('equipmentSearchInput');
    const eqType = document.getElementById('equipmentTypeFilter');
    const eqStatus = document.getElementById('equipmentStatusFilter');

    if (eqSearch) eqSearch.addEventListener('input', debounce(renderEquipmentTable, 150));
    if (eqType) eqType.addEventListener('change', renderEquipmentTable);
    if (eqStatus) eqStatus.addEventListener('change', renderEquipmentTable);

    // History filters
    const histDev = document.getElementById('historyDeviceFilter');
    const histStatus = document.getElementById('historyStatusFilter');
    const histRange = document.getElementById('historyTimeRangeFilter');
    const btnResetHist = document.getElementById('btnResetHistoryFilters');

    if (histDev) histDev.addEventListener('change', renderHistoryTable);
    if (histStatus) histStatus.addEventListener('change', renderHistoryTable);
    if (histRange) histRange.addEventListener('change', renderHistoryTable);

    if (btnResetHist) {
      btnResetHist.addEventListener('click', () => {
        if (histDev) histDev.value = 'all';
        if (histStatus) histStatus.value = 'all';
        if (histRange) histRange.value = '24';
        renderHistoryTable();
      });
    }

    // Pagination
    const prevBtn = document.getElementById('btnPrevPage');
    const nextBtn = document.getElementById('btnNextPage');

    if (prevBtn) {
      prevBtn.addEventListener('click', () => {
        if (state.historyPagination.page > 1) {
          state.historyPagination.page--;
          renderHistoryTable();
        }
      });
    }

    if (nextBtn) {
      nextBtn.addEventListener('click', () => {
        state.historyPagination.page++;
        renderHistoryTable();
      });
    }

    // Acknowledge All Alerts Button
    const btnAckAll = document.getElementById('btnAcknowledgeAll');
    if (btnAckAll) {
      btnAckAll.addEventListener('click', () => {
        const pending = getActiveAlerts();
        if (pending.length === 0) {
          showToast('Все предупреждения уже подтверждены', 'info');
          return;
        }
        state.alerts.forEach(a => {
          a.status = 'resolved';
          a.statusText = 'Устранено (Групповое подтверждение)';
        });
        saveAlerts(state.alerts);
        renderAlertsView();
        renderOverviewKPIs();
        renderRecentEvents();
        showToast('Все активные предупреждения успешно подтверждены', 'success');
      });
    }

    // Quick daily export button on overview
    const btnQuickReport = document.getElementById('btnQuickReport');
    if (btnQuickReport) {
      btnQuickReport.addEventListener('click', exportTelemetryCsv);
    }
  }

  // ==========================================================================
  // REAL CSV EXPORT
  // ==========================================================================
  function setupCsvExport() {
    const btnExport = document.getElementById('btnExportCsv');
    if (btnExport) {
      btnExport.addEventListener('click', exportTelemetryCsv);
    }
  }

  function exportTelemetryCsv() {
    if (state.telemetryHistory.length === 0) {
      showToast('Нет данных телеметрии для экспорта', 'warning');
      return;
    }

    // UTF-8 BOM for Microsoft Excel Russian compatibility
    let csvContent = '\uFEFF';
    csvContent += 'Дата и время;Устройство;Температура (°C);Нижний предел (°C);Верхний предел (°C);Статус;Примечание\r\n';

    state.telemetryHistory.forEach(item => {
      const dt = formatFullDateTime(new Date(item.timestamp));
      const row = [
        `"${dt}"`,
        `"${item.deviceName}"`,
        item.temp.toFixed(1).replace('.', ','),
        item.minTemp.toFixed(1).replace('.', ','),
        item.maxTemp.toFixed(1).replace('.', ','),
        `"${getStatusRussianLabel(item.status)}"`,
        `"${item.note || ''}"`
      ].join(';');
      csvContent += row + '\r\n';
    });

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    const dateStr = new Date().toISOString().slice(0, 10);
    link.setAttribute('href', url);
    link.setAttribute('download', `coldguard-telemetry-report-${dateStr}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);

    showToast('Файл отчета coldguard-telemetry-report.csv успешно выгружен', 'success');
  }

  // ==========================================================================
  // TOAST NOTIFICATIONS
  // ==========================================================================
  function showToast(message, type = 'info') {
    const container = document.getElementById('toastContainer');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;

    let iconSvg = '';
    if (type === 'success') {
      iconSvg = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>`;
    } else if (type === 'warning' || type === 'danger') {
      iconSvg = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`;
    } else {
      iconSvg = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>`;
    }

    toast.innerHTML = `
      ${iconSvg}
      <span>${escapeHtml(message)}</span>
    `;

    container.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(10px)';
      toast.style.transition = 'all 200ms ease-in';
      setTimeout(() => {
        if (toast.parentNode) toast.parentNode.removeChild(toast);
      }, 250);
    }, 3800);
  }

  // ==========================================================================
  // UTILITY HELPERS
  // ==========================================================================
  function formatTemp(val) {
    if (typeof val !== 'number') return '-- °C';
    const sign = val > 0 ? '+' : '';
    return `${sign}${val.toFixed(1)} °C`;
  }

  function formatTempRange(min, max) {
    const minSign = min > 0 ? '+' : '';
    const maxSign = max > 0 ? '+' : '';
    return `${minSign}${min.toFixed(1)} ... ${maxSign}${max.toFixed(1)} °C`;
  }

  function getStatusColor(status) {
    if (status === 'danger') return 'var(--status-danger)';
    if (status === 'warning') return 'var(--status-warning)';
    return 'var(--status-normal)';
  }

  function getBadgeClass(status) {
    if (status === 'danger') return 'badge-danger';
    if (status === 'warning') return 'badge-warning';
    return 'badge-normal';
  }

  function getStatusRussianLabel(status) {
    if (status === 'danger') return 'Критическое';
    if (status === 'warning') return 'Предупреждение';
    return 'В норме';
  }

  function formatTime(date) {
    return `${padZero(date.getHours())}:${padZero(date.getMinutes())}:${padZero(date.getSeconds())}`;
  }

  function formatFullDateTime(date) {
    const day = padZero(date.getDate());
    const month = padZero(date.getMonth() + 1);
    const year = date.getFullYear();
    const time = formatTime(date);
    return `${day}.${month}.${year} ${time}`;
  }

  function formatTimeAgo(date) {
    const diffSec = Math.floor((Date.now() - date.getTime()) / 1000);
    if (diffSec < 15) return 'только что';
    if (diffSec < 60) return `${diffSec} сек назад`;
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `${diffMin} мин назад`;
    const diffHours = Math.floor(diffMin / 60);
    if (diffHours < 24) return `${diffHours} ч назад`;
    return `${Math.floor(diffHours / 24)} дн назад`;
  }

  function padZero(num) {
    return String(num).padStart(2, '0');
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function debounce(fn, wait) {
    let timeout;
    return function (...args) {
      clearTimeout(timeout);
      timeout = setTimeout(() => fn.apply(this, args), wait);
    };
  }

})();
