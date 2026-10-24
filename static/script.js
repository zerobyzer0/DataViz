/*
 * DataViz — frontend logic (enhanced with micro-interactions)
 *
 * 1. Upload:  send the chosen file to Flask  (POST /upload)
 * 2. Preview: show the columns and first rows Flask sends back
 * 3. Chart:   send the chart type + columns to Flask (POST /chart),
 *             then draw the returned data with Plotly.js
 */
(function () {
  "use strict";

  var MAX_MB = Number(document.body.dataset.maxMb) || 5;
  var ALLOWED = ["csv", "xlsx", "xls"];
  var PALETTE = ["#4361ee", "#e4572e", "#f2a900", "#3d5a80", "#7b9e89",
                 "#a8576b", "#2e4057", "#c9a227", "#5b8e7d", "#8d99ae"];
  var FONT = '"Inter", -apple-system, "Segoe UI", system-ui, sans-serif';

  // What each chart type needs from the user
  var CHARTS = {
    bar: {
      label: "bar graph", needs: "one text column and one numeric column",
      xLabel: "Category column", yLabel: "Value column", usesAgg: true,
      hint: "Compares a value across categories."
    },
    pie: {
      label: "pie chart", needs: "one text column and one numeric column",
      xLabel: "Category column", yLabel: "Value column", usesAgg: true,
      hint: "Shows each category's share of the total."
    },
    scatter: {
      label: "scatter plot", needs: "two numeric columns",
      xLabel: "X-axis column (numeric)", yLabel: "Y-axis column (numeric)", usesAgg: false,
      hint: "Shows the relationship between two numbers."
    },
    line: {
      label: "line graph", needs: "one numeric column",
      xLabel: "X-axis column (dates or numbers work best)", yLabel: "Y-axis column (numeric)", usesAgg: false,
      hint: "Shows how a value changes across ordered data."
    },
    histogram: {
      label: "histogram", needs: "one numeric column",
      xLabel: "Numeric column", yLabel: "", usesAgg: false,
      hint: "Shows how the values of one column are spread out."
    }
  };

  function $(id) { return document.getElementById(id); }

  var el = {
    themeToggle: $("theme-toggle"), themeStatus: $("theme-status"),
    dropzone: $("dropzone"), fileInput: $("file-input"), chooseBtn: $("choose-btn"),
    fileName: $("file-name"), uploadBtn: $("upload-btn"), uploadMsg: $("upload-message"),
    previewSection: $("preview-section"), stats: $("stats"),
    columnBody: document.querySelector("#column-table tbody"),
    previewHead: document.querySelector("#preview-table thead"),
    previewBody: document.querySelector("#preview-table tbody"),
    previewHeading: $("preview-heading"),
    chartSection: $("chart-section"), chartType: $("chart-type"),
    chartHint: $("chart-hint"),
    xField: $("x-field"), xLabel: $("x-label"), xCol: $("x-col"),
    yField: $("y-field"), yLabel: $("y-label"), yCol: $("y-col"),
    aggField: $("agg-field"), agg: $("agg"),
    generateBtn: $("generate-btn"), downloadBtn: $("download-btn"),
    chartMsg: $("chart-message"), chartEmpty: $("chart-empty"),
    chart: $("chart"), chartNote: $("chart-note"),
    loading: $("loading"), loadingText: $("loading-text")
  };

  var selectedFile = null;
  var dataset = null;       // the JSON returned by /upload
  var lastTitle = "chart";
  var lastChartData = null; // store for redrawing on theme switch

  // ------------------------------------------------------------------
  // Small helpers
  // ------------------------------------------------------------------
  function showMessage(target, type, text) {
    target.textContent = "";
    var box = document.createElement("div");
    box.className = "message message-" + type;
    box.setAttribute("role", type === "error" ? "alert" : "status");
    box.textContent = text;
    target.appendChild(box);
  }

  function clearMessage(target) { target.textContent = ""; }

  function showLoading(text) {
    el.loadingText.textContent = text;
    el.loading.hidden = false;
  }

  function hideLoading() { el.loading.hidden = true; }

  function scrollToSection(section) {
    var reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    section.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
  }

  function formatSize(bytes) {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  }

  function extensionOf(name) {
    var i = name.lastIndexOf(".");
    return i === -1 ? "" : name.slice(i + 1).toLowerCase();
  }

  function readJson(response) {
    return response.json().catch(function () {
      return { success: false, error: "The server sent an unexpected response (status " + response.status + ")." };
    });
  }

  function friendlyError(err) {
    if (err instanceof TypeError) {
      return "Could not reach the server. Make sure app.py is still running.";
    }
    return err.message || "Something went wrong.";
  }

  function makeCell(tag, text, className) {
    var cell = document.createElement(tag);
    cell.textContent = text;
    if (className) cell.className = className;
    return cell;
  }

  // ------------------------------------------------------------------
  // UI Enhancement: Ripple effect on buttons
  // ------------------------------------------------------------------
  function createRipple(event) {
    var button = event.currentTarget;
    if (button.disabled) return;

    var circle = document.createElement("span");
    var diameter = Math.max(button.clientWidth, button.clientHeight);
    var radius = diameter / 2;
    var rect = button.getBoundingClientRect();

    circle.style.width = circle.style.height = diameter + "px";
    circle.style.left = (event.clientX - rect.left - radius) + "px";
    circle.style.top = (event.clientY - rect.top - radius) + "px";
    circle.className = "ripple";

    // Remove old ripples
    var existingRipple = button.querySelector(".ripple");
    if (existingRipple) existingRipple.remove();

    button.appendChild(circle);
    setTimeout(function () { circle.remove(); }, 600);
  }

  // ------------------------------------------------------------------
  // UI Enhancement: Counter animation for stats
  // ------------------------------------------------------------------
  function animateCounter(element, targetValue) {
    var duration = 800;
    var startTime = null;
    var startValue = 0;

    function easeOutCubic(t) {
      return 1 - Math.pow(1 - t, 3);
    }

    function step(timestamp) {
      if (!startTime) startTime = timestamp;
      var progress = Math.min((timestamp - startTime) / duration, 1);
      var easedProgress = easeOutCubic(progress);
      var currentValue = Math.round(startValue + (targetValue - startValue) * easedProgress);
      element.textContent = currentValue.toLocaleString();
      if (progress < 1) {
        requestAnimationFrame(step);
      }
    }

    requestAnimationFrame(step);
  }

  // ------------------------------------------------------------------
  // UI Enhancement: Active step tracking
  // ------------------------------------------------------------------
  function updateActiveStep(stepNumber) {
    var panels = document.querySelectorAll(".panel");
    panels.forEach(function (panel, index) {
      panel.classList.remove("is-active", "is-completed");
      if (index + 1 < stepNumber) {
        panel.classList.add("is-completed");
      } else if (index + 1 === stepNumber) {
        panel.classList.add("is-active");
      }
    });
  }

  // ------------------------------------------------------------------
  // UI Enhancement: Disabled button tooltips
  // ------------------------------------------------------------------
  function updateDisabledTooltips() {
    if (el.uploadBtn.disabled) {
      el.uploadBtn.title = "Select a file first to upload";
    } else {
      el.uploadBtn.title = "";
    }
    if (el.downloadBtn.disabled) {
      el.downloadBtn.title = "Generate a chart first to export";
    } else {
      el.downloadBtn.title = "";
    }
  }

  // ------------------------------------------------------------------
  // Step 1: choosing and uploading a file
  // ------------------------------------------------------------------
  function selectFile(file) {
    clearMessage(el.uploadMsg);
    if (!file) return;

    if (ALLOWED.indexOf(extensionOf(file.name)) === -1) {
      selectedFile = null;
      el.fileName.textContent = "No file selected";
      el.fileName.classList.remove("is-set");
      el.uploadBtn.disabled = true;
      showMessage(el.uploadMsg, "error", "Unsupported file type. Please choose a .csv, .xlsx or .xls file.");
      updateDisabledTooltips();
      return;
    }
    if (file.size > MAX_MB * 1024 * 1024) {
      selectedFile = null;
      el.fileName.textContent = "No file selected";
      el.fileName.classList.remove("is-set");
      el.uploadBtn.disabled = true;
      showMessage(el.uploadMsg, "error", "That file is " + formatSize(file.size) + ". The limit is " + MAX_MB + " MB.");
      updateDisabledTooltips();
      return;
    }

    selectedFile = file;
    el.fileName.textContent = file.name + " (" + formatSize(file.size) + ")";
    el.fileName.classList.add("is-set");
    el.uploadBtn.disabled = false;
    updateDisabledTooltips();

    // Flash success on dropzone
    el.dropzone.classList.add("is-success");
    setTimeout(function () {
      el.dropzone.classList.remove("is-success");
    }, 1000);
  }

  function uploadFile() {
    if (!selectedFile) return;
    clearMessage(el.uploadMsg);
    showLoading("Reading your file…");

    var form = new FormData();
    form.append("file", selectedFile);

    fetch("/upload", { method: "POST", body: form })
      .then(function (res) {
        return readJson(res).then(function (data) {
          if (!res.ok || !data.success) {
            throw new Error(data.error || "The file could not be processed.");
          }
          return data;
        });
      })
      .then(function (data) {
        dataset = data;
        renderDataset(data);
        showMessage(el.uploadMsg, "success",
          data.filename + " loaded: " + data.rows.toLocaleString() + " rows and " +
          data.column_count + " columns.");
        scrollToSection(el.previewSection);
        updateActiveStep(2);
      })
      .catch(function (err) {
        showMessage(el.uploadMsg, "error", friendlyError(err));
      })
      .then(hideLoading);
  }

  // ------------------------------------------------------------------
  // Step 2: showing the data
  // ------------------------------------------------------------------
  var KIND_LABELS = { numeric: "Number", categorical: "Text", datetime: "Date" };

  function addStat(label, value) {
    var wrap = document.createElement("div");
    var dt = document.createElement("dt");
    var dd = document.createElement("dd");
    dt.textContent = label;

    // Try to animate the counter for numeric values
    var numericValue = parseInt(String(value).replace(/,/g, ""), 10);
    if (!isNaN(numericValue) && numericValue >= 0) {
      dd.textContent = "0";
      wrap.appendChild(dt);
      wrap.appendChild(dd);
      el.stats.appendChild(wrap);
      animateCounter(dd, numericValue);
    } else {
      dd.textContent = value;
      wrap.appendChild(dt);
      wrap.appendChild(dd);
      el.stats.appendChild(wrap);
    }
  }

  function renderDataset(data) {
    // Summary numbers
    el.stats.textContent = "";
    addStat("Rows", data.rows.toLocaleString());
    addStat("Columns", data.column_count);
    addStat("Number columns", data.numeric_columns.length);
    addStat("Text and date columns", data.categorical_columns.length + data.datetime_columns.length);
    addStat("Missing values", data.total_missing.toLocaleString());

    // Column list
    el.columnBody.textContent = "";
    data.columns.forEach(function (col) {
      var row = document.createElement("tr");
      row.appendChild(makeCell("td", col.name));

      var typeCell = document.createElement("td");
      var badge = document.createElement("span");
      badge.className = "badge badge-" + col.kind;
      badge.textContent = KIND_LABELS[col.kind];
      typeCell.appendChild(badge);
      row.appendChild(typeCell);

      row.appendChild(makeCell("td", col.missing === 0 ? "0" : col.missing.toLocaleString(),
        "num" + (col.missing > 0 ? " has-missing" : "")));
      el.columnBody.appendChild(row);
    });

    // Preview table
    el.previewHead.textContent = "";
    el.previewBody.textContent = "";
    var headRow = document.createElement("tr");
    data.columns.forEach(function (col) {
      headRow.appendChild(makeCell("th", col.name, col.kind === "numeric" ? "num" : ""));
    });
    el.previewHead.appendChild(headRow);

    data.preview.forEach(function (values) {
      var tr = document.createElement("tr");
      values.forEach(function (value, i) {
        var isNumber = data.columns[i].kind === "numeric";
        if (value === null) {
          tr.appendChild(makeCell("td", "—", "empty" + (isNumber ? " num" : "")));
        } else {
          tr.appendChild(makeCell("td", String(value), isNumber ? "num" : ""));
        }
      });
      el.previewBody.appendChild(tr);
    });
    el.previewHeading.textContent = "First " + data.preview.length + " of " +
      data.rows.toLocaleString() + " rows";

    // Chart builder
    resetChart();
    clearMessage(el.chartMsg);
    updateChartControls();

    // Reveal sections with animation
    el.previewSection.hidden = false;
    el.previewSection.classList.add("is-visible");
    el.chartSection.hidden = false;
    setTimeout(function () {
      el.chartSection.classList.add("is-visible");
    }, 150);
  }

  // ------------------------------------------------------------------
  // Step 3: choosing the chart type and columns
  // ------------------------------------------------------------------
  function columnChoices(role, type) {
    var numeric = dataset.numeric_columns;
    var text = dataset.categorical_columns;
    var dates = dataset.datetime_columns;
    var all = dataset.columns.map(function (c) { return c.name; });

    if (type === "bar" || type === "pie") {
      if (role === "x") {
        var categories = text.concat(dates);
        return categories.length ? categories : all;   // fall back to every column
      }
      return numeric;
    }
    if (type === "line" && role === "x") return dates.concat(numeric, text);
    if (type === "histogram" && role === "y") return [];
    return numeric;
  }

  function fillSelect(select, options) {
    var previous = select.value;
    select.textContent = "";
    options.forEach(function (name) {
      var opt = document.createElement("option");
      opt.value = name;
      opt.textContent = name;
      select.appendChild(opt);
    });
    if (options.indexOf(previous) !== -1) select.value = previous;
  }

  function updateChartControls() {
    var type = el.chartType.value;
    var cfg = CHARTS[type];

    el.chartHint.textContent = cfg.hint;
    el.xLabel.textContent = cfg.xLabel;
    el.yLabel.textContent = cfg.yLabel;
    el.yField.hidden = type === "histogram";
    el.aggField.hidden = !cfg.usesAgg;

    fillSelect(el.xCol, columnChoices("x", type));
    fillSelect(el.yCol, columnChoices("y", type));

    // For scatter and line charts, avoid choosing the same column twice by default
    if ((type === "scatter" || type === "line") && el.xCol.value === el.yCol.value) {
      var options = Array.prototype.map.call(el.yCol.options, function (o) { return o.value; });
      if (options.length > 1) {
        el.yCol.value = options[(options.indexOf(el.yCol.value) + 1) % options.length];
      }
    }
  }

  // ------------------------------------------------------------------
  // Generating and drawing the chart
  // ------------------------------------------------------------------
  function isDarkMode() {
    return document.documentElement.getAttribute("data-theme") !== "light";
  }

  function resetChart() {
    if (typeof Plotly !== "undefined") Plotly.purge(el.chart);
    el.chart.hidden = true;
    el.chartEmpty.hidden = false;
    el.chartNote.hidden = true;
    el.downloadBtn.disabled = true;
    lastChartData = null;
    updateDisabledTooltips();
  }

  function generateChart() {
    clearMessage(el.chartMsg);
    var type = el.chartType.value;
    var cfg = CHARTS[type];

    if (typeof Plotly === "undefined") {
      showMessage(el.chartMsg, "error",
        "The chart library did not load. Check your internet connection and reload the page.");
      return;
    }
    if (!el.xCol.value || (type !== "histogram" && !el.yCol.value)) {
      showMessage(el.chartMsg, "error",
        "This file does not have the columns a " + cfg.label + " needs: " + cfg.needs + ".");
      return;
    }
    if (type !== "histogram" && el.xCol.value === el.yCol.value) {
      showMessage(el.chartMsg, "error", "Choose two different columns.");
      return;
    }

    // Add loading state to chart box
    var chartBox = el.chart.parentElement;
    chartBox.classList.add("is-loading");

    showLoading("Building your visualization…");
    fetch("/chart", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: dataset.token,
        chart_type: type,
        x: el.xCol.value,
        y: type === "histogram" ? null : el.yCol.value,
        agg: el.agg.value
      })
    })
      .then(function (res) {
        return readJson(res).then(function (data) {
          if (!res.ok || !data.success) {
            throw new Error(data.error || "The graph could not be built.");
          }
          return data.chart;
        });
      })
      .then(function (chart) {
        chartBox.classList.remove("is-loading");
        drawChart(chart);
        showMessage(el.chartMsg, "success",
          "Visualization built from " + chart.rows_used.toLocaleString() + " of " +
          dataset.rows.toLocaleString() + " rows.");

        // Auto-scroll to chart
        setTimeout(function () {
          scrollToSection(chartBox);
        }, 100);
      })
      .catch(function (err) {
        chartBox.classList.remove("is-loading");
        showMessage(el.chartMsg, "error", friendlyError(err));
      })
      .then(hideLoading);
  }

  function baseLayout(chart) {
    var dark = isDarkMode();
    return {
      title: {
        text: chart.title,
        font: { size: 18, family: FONT, weight: 700, color: dark ? "#e8ecf4" : "#0f172a" },
        x: 0.02,
        xanchor: "left"
      },
      paper_bgcolor: dark ? "#1a2035" : "#ffffff",
      plot_bgcolor: dark ? "#1a2035" : "#ffffff",
      font: { family: FONT, color: dark ? "#b0bdd0" : "#475569" },
      margin: { t: 90, r: 28, b: 40, l: 40 },
      showlegend: true,
      legend: {
        orientation: "h",
        x: 1,
        xanchor: "right",
        y: 1.02,
        yanchor: "bottom",
        font: { color: dark ? "#8892a8" : "#64748b" }
      },
      hoverlabel: {
        font: { family: FONT, color: dark ? "#e8ecf4" : "#0f172a" },
        bgcolor: dark ? "#232a48" : "#ffffff",
        bordercolor: dark ? "#3a4468" : "#cbd5e1"
      },
      xaxis: {
        title: { text: chart.x_label, font: { color: dark ? "#8892a8" : "#475569" } },
        automargin: true,
        gridcolor: dark ? "#2a3352" : "#f1f5f9",
        zeroline: false,
        tickfont: { color: dark ? "#8892a8" : "#64748b" }
      },
      yaxis: {
        title: { text: chart.y_label, font: { color: dark ? "#8892a8" : "#475569" } },
        automargin: true,
        gridcolor: dark ? "#2a3352" : "#f1f5f9",
        zerolinecolor: dark ? "#3a4468" : "#e2e8f0",
        tickfont: { color: dark ? "#8892a8" : "#64748b" }
      }
    };
  }

  function buildTrace(chart) {
    var dark = isDarkMode();
    switch (chart.type) {
      case "pie":
        return {
          type: "pie", labels: chart.labels, values: chart.values, sort: false,
          name: chart.y_label, textinfo: "percent",
          marker: { colors: PALETTE, line: { color: dark ? "#1a2035" : "#ffffff", width: 2 } },
          hovertemplate: "<b>%{label}</b><br>" + chart.y_label + ": %{value:,.2f}<br>%{percent}<extra></extra>"
        };
      case "bar":
        return {
          type: "bar", x: chart.labels, y: chart.values, name: chart.y_label,
          marker: { color: PALETTE[0], cornerradius: 4 },
          hovertemplate: "<b>%{x}</b><br>" + chart.y_label + ": %{y:,.2f}<extra></extra>"
        };
      case "scatter":
        return {
          type: "scatter", mode: "markers", x: chart.x, y: chart.y, name: chart.title,
          marker: { color: PALETTE[0], size: 9, opacity: 0.75, line: { color: dark ? "#1a2035" : "#ffffff", width: 1 } },
          hovertemplate: chart.x_label + ": %{x}<br>" + chart.y_label + ": %{y}<extra></extra>"
        };
      case "line":
        return {
          type: "scatter", mode: chart.y.length <= 100 ? "lines+markers" : "lines",
          x: chart.x, y: chart.y, name: chart.y_label,
          line: { color: PALETTE[0], width: 3, shape: "spline" }, marker: { size: 7 },
          hovertemplate: chart.x_label + ": %{x}<br>" + chart.y_label + ": %{y}<extra></extra>"
        };
      default: // histogram
        return {
          type: "histogram", x: chart.values, name: chart.x_label,
          marker: { color: PALETTE[0], line: { color: dark ? "#1a2035" : "#ffffff", width: 1 } },
          hovertemplate: chart.x_label + ": %{x}<br>Count: %{y}<extra></extra>"
        };
    }
  }

  function drawChart(chart) {
    lastChartData = chart;
    var dark = isDarkMode();
    var layout = baseLayout(chart);
    if (chart.type === "pie") {
      delete layout.xaxis;
      delete layout.yaxis;
      layout.legend = { orientation: "v", x: 1.02, xanchor: "left", y: 0.5, font: { color: dark ? "#8892a8" : "#64748b" } };
      layout.margin = { t: 70, r: 20, b: 30, l: 20 };
    }
    if (chart.type === "histogram") layout.bargap = 0.04;

    el.chartEmpty.hidden = true;
    el.chart.hidden = false;
    Plotly.newPlot(el.chart, [buildTrace(chart)], layout,
      { responsive: true, displaylogo: false });

    lastTitle = chart.title;
    el.downloadBtn.disabled = false;
    updateDisabledTooltips();

    if (chart.note) {
      el.chartNote.textContent = chart.note;
      el.chartNote.hidden = false;
    } else {
      el.chartNote.hidden = true;
    }
  }

  function downloadPng() {
    var filename = lastTitle.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "chart";
    Plotly.downloadImage(el.chart, { format: "png", filename: filename, width: 1200, height: 700, scale: 2 });
  }

  // ------------------------------------------------------------------
  // Wiring the page together
  // ------------------------------------------------------------------
  el.chooseBtn.addEventListener("click", function () { el.fileInput.click(); });
  el.fileInput.addEventListener("change", function () { selectFile(el.fileInput.files[0]); });
  el.uploadBtn.addEventListener("click", uploadFile);

  ["dragenter", "dragover"].forEach(function (name) {
    el.dropzone.addEventListener(name, function (e) {
      e.preventDefault();
      el.dropzone.classList.add("is-dragover");
    });
  });
  ["dragleave", "drop"].forEach(function (name) {
    el.dropzone.addEventListener(name, function (e) {
      e.preventDefault();
      el.dropzone.classList.remove("is-dragover");
    });
  });
  el.dropzone.addEventListener("drop", function (e) {
    var files = e.dataTransfer && e.dataTransfer.files;
    if (files && files.length) selectFile(files[0]);
  });

  // Dropping a file outside the drop area should not make the browser open it
  window.addEventListener("dragover", function (e) { e.preventDefault(); });
  window.addEventListener("drop", function (e) { e.preventDefault(); });

  el.chartType.addEventListener("change", function () {
    clearMessage(el.chartMsg);
    updateChartControls();
    updateActiveStep(3);
  });
  el.generateBtn.addEventListener("click", generateChart);
  el.downloadBtn.addEventListener("click", downloadPng);

  // Ripple effect on all buttons
  document.querySelectorAll(".btn").forEach(function (btn) {
    btn.addEventListener("click", createRipple);
  });

  // Keyboard shortcut: Ctrl+Enter or Cmd+Enter to generate chart
  document.addEventListener("keydown", function (e) {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      if (!el.chartSection.hidden && dataset) {
        e.preventDefault();
        generateChart();
      }
    }
  });

  // Chart controls focus triggers step 3 active state
  [el.chartType, el.xCol, el.yCol, el.agg].forEach(function (control) {
    control.addEventListener("focus", function () {
      updateActiveStep(3);
    });
  });

  // ------------------------------------------------------------------
  // Dark / Light Theme Toggle Management
  // ------------------------------------------------------------------
  function applyTheme(theme) {
    var isDark = theme === "dark";
    document.documentElement.setAttribute("data-theme", theme);
    try {
      localStorage.setItem("dataviz-theme", theme);
    } catch (e) {}

    var metaTheme = document.querySelector('meta[name="theme-color"]');
    if (metaTheme) {
      metaTheme.setAttribute("content", isDark ? "#0b0f19" : "#f4f6fb");
    }

    if (el.themeStatus) {
      el.themeStatus.textContent = isDark ? "Light Mode" : "Dark Mode";
    }
    if (el.themeToggle) {
      el.themeToggle.setAttribute("aria-label", isDark ? "Switch to light mode" : "Switch to dark mode");
      el.themeToggle.setAttribute("title", isDark ? "Switch to light mode" : "Switch to dark mode");
    }

    // Immediately re-draw active chart with the new theme colors if visible
    if (lastChartData && !el.chart.hidden && typeof Plotly !== "undefined") {
      drawChart(lastChartData);
    }
  }

  function toggleTheme() {
    var current = document.documentElement.getAttribute("data-theme") || "dark";
    var nextTheme = current === "dark" ? "light" : "dark";
    applyTheme(nextTheme);
  }

  if (el.themeToggle) {
    el.themeToggle.addEventListener("click", toggleTheme);
  }

  // Initialize: step 1 active, tooltips set, and theme initialized
  updateActiveStep(1);
  updateDisabledTooltips();

  var initialTheme = document.documentElement.getAttribute("data-theme");
  if (!initialTheme) {
    try {
      initialTheme = localStorage.getItem("dataviz-theme");
    } catch (e) {}
  }
  if (!initialTheme) {
    initialTheme = (window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches) ? "light" : "dark";
  }
  applyTheme(initialTheme);

})();
