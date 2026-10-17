"""
DataViz - CSV Data Visualization
================================
Flask backend. Its job is to:

  1. Receive an uploaded CSV / Excel file            (POST /upload)
  2. Read it with Pandas and describe its columns
  3. Turn a chart request into chart-ready data      (POST /chart)

The browser (static/script.js) draws the charts with Plotly.js.
The uploaded file is NEVER written to disk: it is read from memory, kept as a
Pandas DataFrame for a short time, and then discarded.
"""

import io
import json
import os
import secrets
import threading
import time
import warnings

import numpy as np
import pandas as pd
from flask import Flask, jsonify, render_template, request
from pandas.api import types as ptypes

# ----------------------------------------------------------------------
# Settings (change these numbers if you want different limits)
# ----------------------------------------------------------------------
MAX_FILE_SIZE_MB = 5            # largest file we accept
ALLOWED_EXTENSIONS = {"csv", "xlsx", "xls"}
MAX_ROWS = 100_000              # refuse very large tables
PREVIEW_ROWS = 10               # rows shown in the preview table
DATASET_TTL_SECONDS = 30 * 60   # forget an upload after 30 idle minutes
MAX_DATASETS = 50               # never keep more than this many uploads in memory
MAX_PIE_SLICES = 10             # pie charts get unreadable beyond this
MAX_BARS = 30                   # bar charts show at most this many bars
MAX_SCATTER_POINTS = 10_000     # scatter plots show at most this many points
TYPE_GUESS_THRESHOLD = 0.9      # a text column is "numeric" if 90% of it parses as numbers

AGG_NAMES = {"sum": "Total", "mean": "Average", "count": "Count of"}

# Matches text that starts like a date, e.g. 2025-01-31, 31/01/2025, 2025.01.31
DATE_PATTERN = r"^\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}"

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = MAX_FILE_SIZE_MB * 1024 * 1024

# Uploaded tables live here (in memory only): token -> (DataFrame, last_used_time)
DATASETS = {}
DATASETS_LOCK = threading.Lock()


class ChartError(Exception):
    """Raised when a chart request cannot be fulfilled. The message is shown to the user."""


# ----------------------------------------------------------------------
# Small helpers
# ----------------------------------------------------------------------
def json_error(message, status=400):
    return jsonify({"success": False, "error": message}), status


def get_extension(filename):
    return filename.rsplit(".", 1)[-1].lower() if "." in filename else ""


def column_kind(series):
    """Classify a column as 'numeric', 'datetime' or 'categorical' (text)."""
    if ptypes.is_bool_dtype(series):
        return "categorical"
    if ptypes.is_numeric_dtype(series):
        return "numeric"
    if ptypes.is_datetime64_any_dtype(series):
        return "datetime"
    return "categorical"


def to_labels(series):
    """Turn any column into text labels (dates are formatted nicely)."""
    if ptypes.is_datetime64_any_dtype(series):
        has_time = (series.dt.normalize() != series).any()
        return series.dt.strftime("%Y-%m-%d %H:%M:%S" if has_time else "%Y-%m-%d")
    return series.astype(str)


def make_unique(names):
    """Make sure no two columns share a name."""
    seen = {}
    result = []
    for name in names:
        name = name or "Unnamed"
        if name in seen:
            seen[name] += 1
            name = f"{name}_{seen[name]}"
        else:
            seen[name] = 0
        result.append(name)
    return result


# ----------------------------------------------------------------------
# Step 1: reading and cleaning the uploaded file
# ----------------------------------------------------------------------
def looks_like_real_file(raw, ext):
    """Cheap security check: does the content match the claimed file type?"""
    if ext == "xlsx":
        return raw[:2] == b"PK"                      # .xlsx is a zip archive
    if ext == "xls":
        return raw[:8] == b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"
    return b"\x00" not in raw[:4096]                 # CSV must be plain text


def read_table(raw, ext):
    """Read the raw bytes into a Pandas DataFrame."""
    buffer = io.BytesIO(raw)
    if ext == "csv":
        try:
            return pd.read_csv(buffer, encoding="utf-8-sig")
        except UnicodeDecodeError:
            buffer.seek(0)
            return pd.read_csv(buffer, encoding="latin-1")
    if ext == "xlsx":
        return pd.read_excel(buffer, engine="openpyxl")
    return pd.read_excel(buffer, engine="xlrd")


def guess_column_types(df):
    """
    Text columns that really hold numbers or dates (common in CSV files) are
    converted, so that they can be used in numeric charts.
    """
    for col in df.columns:
        series = df[col]
        if (ptypes.is_bool_dtype(series) or ptypes.is_numeric_dtype(series)
                or ptypes.is_datetime64_any_dtype(series)):
            continue
        non_null = series.dropna()
        if non_null.empty:
            continue
        needed = TYPE_GUESS_THRESHOLD * len(non_null)

        try:
            numeric = pd.to_numeric(series, errors="coerce")
        except (TypeError, ValueError):
            continue
        if numeric.notna().sum() >= needed:
            df[col] = numeric
            continue

        text = non_null.astype(str).str.strip()
        if text.str.match(DATE_PATTERN).mean() >= TYPE_GUESS_THRESHOLD:
            with warnings.catch_warnings():
                warnings.simplefilter("ignore")
                parsed = pd.to_datetime(series, errors="coerce")
            if parsed.notna().sum() >= needed:
                df[col] = parsed
    return df


def clean_table(df):
    """Tidy column names, drop empty rows/columns, fix column types."""
    df = df.dropna(how="all").dropna(axis=1, how="all").reset_index(drop=True)
    df.columns = make_unique([str(c).strip() for c in df.columns])
    df = guess_column_types(df)
    for col in df.columns:                           # infinity breaks charts
        if ptypes.is_float_dtype(df[col]):
            df[col] = df[col].replace([np.inf, -np.inf], np.nan)
    return df


def make_preview(df):
    """First rows of the table as plain lists (missing values become null)."""
    head = df.head(PREVIEW_ROWS).copy()
    for col in head.columns:
        if ptypes.is_datetime64_any_dtype(head[col]):
            head[col] = to_labels(head[col])
    return json.loads(head.to_json(orient="split"))["data"]


# ----------------------------------------------------------------------
# In-memory storage for uploaded tables
# ----------------------------------------------------------------------
def save_dataset(df):
    now = time.time()
    with DATASETS_LOCK:
        for token in [t for t, (_, used) in DATASETS.items() if now - used > DATASET_TTL_SECONDS]:
            del DATASETS[token]
        while len(DATASETS) >= MAX_DATASETS:
            del DATASETS[min(DATASETS, key=lambda t: DATASETS[t][1])]
        token = secrets.token_urlsafe(16)
        DATASETS[token] = (df, now)
    return token


def load_dataset(token):
    if not isinstance(token, str):
        return None
    with DATASETS_LOCK:
        entry = DATASETS.get(token)
        if entry is None:
            return None
        df, used = entry
        if time.time() - used > DATASET_TTL_SECONDS:
            del DATASETS[token]
            return None
        DATASETS[token] = (df, time.time())          # keep it alive while in use
        return df


# ----------------------------------------------------------------------
# Chart builders: each one reads the REAL DataFrame and returns chart-ready data
# ----------------------------------------------------------------------
def require_column(df, name, role):
    if not isinstance(name, str) or name not in df.columns:
        raise ChartError(f"Please choose a valid column for {role}.")
    return name


def require_numeric(df, name, role):
    require_column(df, name, role)
    if column_kind(df[name]) != "numeric":
        raise ChartError(f'"{name}" is not a numeric column. Choose a numeric column for {role}.')
    return name


def require_different(x, y):
    if x == y:
        raise ChartError("Choose two different columns for the X and Y axes.")


def group_by_category(df, x, y, agg):
    """Sum / average / count of y for every value of x, largest first."""
    if agg not in AGG_NAMES:
        raise ChartError("Unknown calculation. Choose Sum, Average or Count.")
    require_column(df, x, "the category")
    require_numeric(df, y, "the values")
    require_different(x, y)
    data = df[[x, y]].dropna()
    if data.empty:
        raise ChartError("These columns have no complete rows (every row has a missing value).")
    grouped = data[y].groupby(to_labels(data[x])).agg(agg)
    return grouped.sort_values(ascending=False), len(data)


def build_pie(df, x, y, agg):
    grouped, rows_used = group_by_category(df, x, y, agg)
    if (grouped < 0).any():
        raise ChartError("A pie chart cannot show negative values. Try a bar graph instead.")
    if grouped.sum() <= 0:
        raise ChartError("All values are zero, so there is nothing to show in a pie chart.")

    note = None
    labels, values = grouped.index.tolist(), grouped.tolist()
    if len(grouped) > MAX_PIE_SLICES:
        total = len(grouped)
        if agg in ("sum", "count"):
            keep = MAX_PIE_SLICES - 1
            labels = labels[:keep] + ["Other"]
            values = values[:keep] + [float(grouped.iloc[keep:].sum())]
            note = f"Showing the top {keep} of {total} categories. The rest are grouped as 'Other'."
        else:
            labels, values = labels[:MAX_PIE_SLICES], values[:MAX_PIE_SLICES]
            note = f"Showing the top {MAX_PIE_SLICES} of {total} categories."

    value_label = f"{AGG_NAMES[agg]} {y}"
    return {"type": "pie", "title": f"{value_label} by {x}", "labels": labels,
            "values": values, "x_label": x, "y_label": value_label,
            "rows_used": rows_used, "note": note}


def build_bar(df, x, y, agg):
    grouped, rows_used = group_by_category(df, x, y, agg)
    note = None
    if len(grouped) > MAX_BARS:
        note = f"Showing the top {MAX_BARS} of {len(grouped)} categories."
        grouped = grouped.iloc[:MAX_BARS]

    value_label = f"{AGG_NAMES[agg]} {y}"
    return {"type": "bar", "title": f"{value_label} by {x}", "labels": grouped.index.tolist(),
            "values": grouped.tolist(), "x_label": x, "y_label": value_label,
            "rows_used": rows_used, "note": note}


def build_scatter(df, x, y, agg):
    require_numeric(df, x, "the X-axis")
    require_numeric(df, y, "the Y-axis")
    require_different(x, y)
    data = df[[x, y]].dropna()
    if data.empty:
        raise ChartError("These columns have no complete rows (every row has a missing value).")

    note = None
    rows_used = len(data)
    if rows_used > MAX_SCATTER_POINTS:
        data = data.sample(MAX_SCATTER_POINTS, random_state=1)
        note = f"Showing a random sample of {MAX_SCATTER_POINTS:,} of {rows_used:,} points."
    return {"type": "scatter", "title": f"{y} vs {x}", "x": data[x].tolist(),
            "y": data[y].tolist(), "x_label": x, "y_label": y,
            "rows_used": rows_used, "note": note}


def build_line(df, x, y, agg):
    require_column(df, x, "the X-axis")
    require_numeric(df, y, "the Y-axis")
    require_different(x, y)
    data = df[[x, y]].dropna()
    if data.empty:
        raise ChartError("These columns have no complete rows (every row has a missing value).")

    rows_used = len(data)
    kind = column_kind(data[x])
    if kind != "categorical":
        data = data.sort_values(x)                    # trends need ordered X values

    note = None
    if data[x].duplicated().any():
        data = data.groupby(x, as_index=False, sort=(kind != "categorical"))[y].mean()
        note = "Some X values appear more than once, so the average Y value is plotted for each."

    x_values = data[x].tolist() if kind == "numeric" else to_labels(data[x]).tolist()
    return {"type": "line", "title": f"{y} by {x}", "x": x_values, "y": data[y].tolist(),
            "x_label": x, "y_label": y, "rows_used": rows_used, "note": note}


def build_histogram(df, x, y, agg):
    require_numeric(df, x, "the histogram")
    values = df[x].dropna()
    if values.empty:
        raise ChartError(f'Column "{x}" has no values (all are missing).')
    return {"type": "histogram", "title": f"Distribution of {x}", "values": values.tolist(),
            "x_label": x, "y_label": "Count", "rows_used": len(values), "note": None}


CHART_BUILDERS = {
    "pie": build_pie,
    "bar": build_bar,
    "scatter": build_scatter,
    "line": build_line,
    "histogram": build_histogram,
}


# ----------------------------------------------------------------------
# Routes
# ----------------------------------------------------------------------
@app.route("/")
def index():
    return render_template("index.html", max_mb=MAX_FILE_SIZE_MB)


@app.route("/upload", methods=["POST"])
def upload():
    file = request.files.get("file")
    if file is None or not file.filename:
        return json_error("No file received. Choose a CSV or Excel file first.")

    filename = os.path.basename(file.filename)
    ext = get_extension(filename)
    if ext not in ALLOWED_EXTENSIONS:
        return json_error("Unsupported file type. Please upload a .csv, .xlsx or .xls file.")

    raw = file.read()
    if not raw:
        return json_error("The file is empty.")
    if not looks_like_real_file(raw, ext):
        return json_error(f"This file does not look like a valid .{ext} file.")

    try:
        df = read_table(raw, ext)
    except pd.errors.EmptyDataError:
        return json_error("The file is empty or has no columns.")
    except pd.errors.ParserError:
        return json_error("The file is malformed. Check that every row has the same number of columns.")
    except Exception:
        app.logger.exception("Could not read uploaded file")
        return json_error("The file could not be read. Make sure it is a valid CSV or Excel file.")

    df = clean_table(df)
    if df.empty or len(df.columns) == 0:
        return json_error("The file contains no data rows.")
    if len(df) > MAX_ROWS:
        return json_error(f"The file has {len(df):,} rows. The limit is {MAX_ROWS:,} rows.")

    columns = [{"name": c, "kind": column_kind(df[c]), "missing": int(df[c].isna().sum())}
               for c in df.columns]
    return jsonify({
        "success": True,
        "token": save_dataset(df),
        "filename": filename[:120],
        "rows": int(len(df)),
        "column_count": int(len(df.columns)),
        "columns": columns,
        "numeric_columns": [c["name"] for c in columns if c["kind"] == "numeric"],
        "categorical_columns": [c["name"] for c in columns if c["kind"] == "categorical"],
        "datetime_columns": [c["name"] for c in columns if c["kind"] == "datetime"],
        "total_missing": int(df.isna().sum().sum()),
        "preview": make_preview(df),
    })


@app.route("/chart", methods=["POST"])
def chart():
    payload = request.get_json(silent=True) or {}
    df = load_dataset(payload.get("token"))
    if df is None:
        return json_error("Your uploaded data has expired. Please upload the file again.", 404)

    builder = CHART_BUILDERS.get(payload.get("chart_type"))
    if builder is None:
        return json_error("Unknown chart type.")

    try:
        result = builder(df, payload.get("x"), payload.get("y"), payload.get("agg", "sum"))
    except ChartError as err:
        return json_error(str(err))
    except Exception:
        app.logger.exception("Chart generation failed")
        return json_error("Something went wrong while building the chart.", 500)
    return jsonify({"success": True, "chart": result})


@app.errorhandler(413)
def file_too_large(_error):
    return json_error(f"The file is too large. The limit is {MAX_FILE_SIZE_MB} MB.", 413)


@app.after_request
def add_security_headers(response):
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    return response


if __name__ == "__main__":
    # debug=False is the safe default. Set it to True only while developing.
    app.run(host="127.0.0.1", port=5000, debug=False)
