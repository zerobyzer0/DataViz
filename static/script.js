/*
 * DataViz — frontend logic
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
  var PALETTE = ["#0e6e6a", "#e4572e", "#f2a900", "#3d5a80", "#7b9e89",
                 "#a8576b", "#2e4057", "#c9a227", "#5b8e7d", "#8d99ae"];
  var FONT = '"IBM Plex Sans", "Segoe UI", system-ui, sans-serif';

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
      return;
    }
    if (file.size > MAX_MB * 1024 * 1024) {
      selectedFile = null;
      el.fileName.textContent = "No file selected";
      el.fileName.classList.remove("is-set");
      el.uploadBtn.disabled = true;
      showMessage(el.uploadMsg, "error", "That file is " + formatSize(file.size) + ". The limit is " + MAX_MB + " MB.");
      return;
    }

    selectedFile = file;
    el.fileName.textContent = file.name + " (" + formatSize(file.size) + ")";
    el.fileName.classList.add("is-set");
    el.uploadBtn.disabled = false;
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
    dd.textContent = value;
    wrap.appendChild(dt);
    wrap.appendChild(dd);
    el.stats.appendChild(wrap);
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
    el.previewSection.hidden = false;
    el.chartSection.hidden = false;
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
  function resetChart() {
    if (typeof Plotly !== "undefined") Plotly.purge(el.chart);
    el.chart.hidden = true;
    el.chartEmpty.hidden = false;
    el.chartNote.hidden = true;
    el.downloadBtn.disabled = true;
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

    showLoading("Building your graph…");
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
        drawChart(chart);
        showMessage(el.chartMsg, "success",
          "Graph built from " + chart.rows_used.toLocaleString() + " of " +
          dataset.rows.toLocaleString() + " rows.");
      })
      .catch(function (err) {
        showMessage(el.chartMsg, "error", friendlyError(err));
      })
      .then(hideLoading);
  }

  function baseLayout(chart) {
    return {
      title: { text: chart.title, font: { size: 18 }, x: 0.02, xanchor: "left" },
      paper_bgcolor: "#ffffff",
      plot_bgcolor: "#ffffff",
      font: { family: FONT, color: "#16222e" },
      margin: { t: 90, r: 28, b: 40, l: 40 },
      showlegend: true,
      legend: { orientation: "h", x: 1, xanchor: "right", y: 1.02, yanchor: "bottom" },
      hoverlabel: { font: { family: FONT } },
      xaxis: { title: { text: chart.x_label }, automargin: true, gridcolor: "#e6ecea", zeroline: false },
      yaxis: { title: { text: chart.y_label }, automargin: true, gridcolor: "#e6ecea", zerolinecolor: "#c5d0cd" }
    };
  }

  function buildTrace(chart) {
    switch (chart.type) {
      case "pie":
        return {
          type: "pie", labels: chart.labels, values: chart.values, sort: false,
          name: chart.y_label, textinfo: "percent",
          marker: { colors: PALETTE, line: { color: "#ffffff", width: 2 } },
          hovertemplate: "<b>%{label}</b><br>" + chart.y_label + ": %{value:,.2f}<br>%{percent}<extra></extra>"
        };
      case "bar":
        return {
          type: "bar", x: chart.labels, y: chart.values, name: chart.y_label,
          marker: { color: PALETTE[0] },
          hovertemplate: "<b>%{x}</b><br>" + chart.y_label + ": %{y:,.2f}<extra></extra>"
        };
      case "scatter":
        return {
          type: "scatter", mode: "markers", x: chart.x, y: chart.y, name: chart.title,
          marker: { color: PALETTE[0], size: 9, opacity: 0.75, line: { color: "#ffffff", width: 1 } },
          hovertemplate: chart.x_label + ": %{x}<br>" + chart.y_label + ": %{y}<extra></extra>"
        };
      case "line":
        return {
          type: "scatter", mode: chart.y.length <= 100 ? "lines+markers" : "lines",
          x: chart.x, y: chart.y, name: chart.y_label,
          line: { color: PALETTE[0], width: 3 }, marker: { size: 7 },
          hovertemplate: chart.x_label + ": %{x}<br>" + chart.y_label + ": %{y}<extra></extra>"
        };
      default: // histogram
        return {
          type: "histogram", x: chart.values, name: chart.x_label,
          marker: { color: PALETTE[0], line: { color: "#ffffff", width: 1 } },
          hovertemplate: chart.x_label + ": %{x}<br>Count: %{y}<extra></extra>"
        };
    }
  }

  function drawChart(chart) {
    var layout = baseLayout(chart);
    if (chart.type === "pie") {
      delete layout.xaxis;
      delete layout.yaxis;
      layout.legend = { orientation: "v", x: 1.02, xanchor: "left", y: 0.5 };
      layout.margin = { t: 70, r: 20, b: 30, l: 20 };
    }
    if (chart.type === "histogram") layout.bargap = 0.04;

    el.chartEmpty.hidden = true;
    el.chart.hidden = false;
    Plotly.newPlot(el.chart, [buildTrace(chart)], layout,
      { responsive: true, displaylogo: false });

    lastTitle = chart.title;
    el.downloadBtn.disabled = false;

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
  });
  el.generateBtn.addEventListener("click", generateChart);
  el.downloadBtn.addEventListener("click", downloadPng);
})();
