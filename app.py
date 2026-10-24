import pandas as pd
from flask import Flask, jsonify, render_template, request
from flask_cors import CORS

app = Flask(__name__)
CORS(app)

# Simple dictionary to keep the uploaded DataFrame in memory
MY_STORAGE = {}
# ----------------------------------------------------------------------
# Route 1: Load the main webpage (http://127.0.0.1:5000/)
# ----------------------------------------------------------------------
@app.route("/")
def index():
    return render_template("index.html", max_mb=5)


# ----------------------------------------------------------------------
# Route 2: Receive the file and read it with Pandas
# ----------------------------------------------------------------------
@app.route("/upload", methods=["POST"])
def upload():
    # 1. Get the uploaded file from the webpage
    file = request.files.get("file")
    if file is None or file.filename == "":
        return jsonify({"success": False, "error": "No file selected."}), 400

    filename = file.filename

    # 2. Read CSV or Excel into a Pandas DataFrame
    try:
        if filename.lower().endswith(".csv"):
            df = pd.read_csv(file)
        elif filename.lower().endswith((".xlsx", ".xls")):
            df = pd.read_excel(file)
        else:
            return jsonify({"success": False, "error": "Please upload a CSV or Excel file."}), 400
    except Exception:
        return jsonify({"success": False, "error": "Could not read the file."}), 400

    # 3. Clean data: remove completely empty rows and columns
    df = df.dropna(how="all")
    df = df.dropna(axis=1, how="all")

    # 4. Save the DataFrame in our dictionary
    MY_STORAGE["my_data"] = df

    # 5. Check each column using a simple loop
    columns_info = []
    numeric_cols = []
    text_cols = []

    for col in df.columns:
        missing_count = int(df[col].isna().sum())

        # Check if the column holds numbers (int or float) or text
        if pd.api.types.is_numeric_dtype(df[col]) and not pd.api.types.is_bool_dtype(df[col]):
            kind = "numeric"
            numeric_cols.append(col)
        else:
            kind = "categorical"
            text_cols.append(col)

        columns_info.append({
            "name": str(col),
            "kind": kind,
            "missing": missing_count
        })

    # 6. Take top 10 rows for the preview table
    preview_df = df.head(10).fillna("")
    preview_rows = preview_df.astype(str).values.tolist()

    # 7. Send all details back to the webpage
    return jsonify({
        "success": True,
        "token": "my_data",
        "filename": filename,
        "rows": len(df),
        "column_count": len(df.columns),
        "columns": columns_info,
        "numeric_columns": numeric_cols,
        "categorical_columns": text_cols,
        "datetime_columns": [],
        "total_missing": int(df.isna().sum().sum()),
        "preview": preview_rows
    })


# ----------------------------------------------------------------------
# Route 3: Calculate numbers for the selected chart
# ----------------------------------------------------------------------
@app.route("/chart", methods=["POST"])
def chart():
    # 1. Read what the user selected in the dropdowns
    data = request.get_json()
    chart_type = data.get("chart_type")
    x = data.get("x")
    y = data.get("y")
    agg = data.get("agg", "sum")

    # 2. Get our saved DataFrame from the dictionary
    if "my_data" not in MY_STORAGE:
        return jsonify({"success": False, "error": "Please upload a file first."}), 404

    df = MY_STORAGE["my_data"]

    # 3. Use basic Pandas commands to prepare chart data
    try:
        if chart_type in ["pie", "bar"]:
            clean_df = df[[x, y]].dropna()
            # Group by X and calculate sum, mean, or count of Y
            grouped = clean_df.groupby(x)[y].agg(agg)
            grouped = grouped.sort_values(ascending=False).head(12)

            chart_data = {
                "type": chart_type,
                "title": f"{agg.title()} of {y} by {x}",
                "labels": grouped.index.astype(str).tolist(),
                "values": grouped.values.tolist(),
                "x_label": x,
                "y_label": y,
                "rows_used": len(clean_df),
                "note": None
            }

        elif chart_type == "scatter":
            clean_df = df[[x, y]].dropna().head(1000)

            chart_data = {
                "type": "scatter",
                "title": f"{y} vs {x}",
                "x": clean_df[x].tolist(),
                "y": clean_df[y].tolist(),
                "x_label": x,
                "y_label": y,
                "rows_used": len(clean_df),
                "note": None
            }

        elif chart_type == "line":
            clean_df = df[[x, y]].dropna()
            grouped = clean_df.groupby(x)[y].mean()

            chart_data = {
                "type": "line",
                "title": f"Average {y} by {x}",
                "x": grouped.index.astype(str).tolist(),
                "y": grouped.values.tolist(),
                "x_label": x,
                "y_label": y,
                "rows_used": len(clean_df),
                "note": None
            }

        elif chart_type == "histogram":
            clean_values = df[x].dropna()

            chart_data = {
                "type": "histogram",
                "title": f"Distribution of {x}",
                "values": clean_values.tolist(),
                "x_label": x,
                "y_label": "Count",
                "rows_used": len(clean_values),
                "note": None
            }

        else:
            return jsonify({"success": False, "error": "Invalid chart type."}), 400

        return jsonify({"success": True, "chart": chart_data})

    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 400


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000, debug=True)
