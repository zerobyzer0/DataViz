# DataViz — CSV Data Visualization

Upload a CSV or Excel file, preview it, pick a chart type and columns, and see an interactive chart built from the file's real data.

**Stack:** HTML, CSS, JavaScript · Python Flask · Pandas · Plotly.js

---

## 1. Architecture and workflow

```
┌────────────────────────── BROWSER ──────────────────────────┐
│  index.html + style.css + script.js (Plotly.js draws charts)│
└───────┬──────────────────────────────────────▲──────────────┘
        │ 1. POST /upload  (the file)           │ 2. JSON: columns, types,
        │ 3. POST /chart   (type + columns)     │    missing values, preview
        ▼                                       │ 4. JSON: chart-ready data
┌────────────────────────── FLASK (app.py) ───────────────────┐
│  validate file → Pandas read_csv / read_excel → clean       │
│  keep the DataFrame in memory (token) → aggregate for chart │
└─────────────────────────────────────────────────────────────┘
```

| Step | Where | What happens |
|------|-------|--------------|
| 1. Upload | Browser | User drops or chooses a file, sees its name, clicks **Upload File**. |
| 2. Process | Flask + Pandas | File is validated, read with `read_csv()` / `read_excel()`, cleaned. Columns are classified as number / text / date and missing values are counted. |
| 3. Preview | Browser | Row count, column count, column table (name, type, missing) and the first 10 rows are shown. |
| 4. Choose | Browser | User picks a chart type. The column menus are filled from the real columns and change with the chart type. |
| 5. Generate | Flask → Browser | Browser sends the choice to `/chart`. Pandas groups or filters the real DataFrame and returns the numbers. Plotly draws them on the same page. |
| 6. Download | Browser | **Download PNG** saves the chart image (Plotly's `downloadImage`). |

### How the pieces work together (viva summary)

- **Frontend (HTML/CSS/JS)** collects input and displays results. It never calculates chart values itself.
- **Flask** is the server. It exposes three routes: `/` (the page), `/upload` and `/chart`.
- **Pandas** does all data work: reading the file, detecting types, counting missing values, `groupby` for pie/bar, `dropna` and sorting for the others.
- **Plotly.js** receives the numbers from Flask and draws interactive charts with tooltips, legends, zoom and PNG export.
- **JSON** is the language between browser and server (`fetch()` on the browser side, `jsonify()` on the Flask side).

### What each chart does

| Chart | You choose | Pandas does |
|-------|-----------|-------------|
| Pie | text column + number column | Sum / average / count of the numbers per category (top 9 plus "Other") |
| Bar | text column + number column | Same, top 30 categories, largest first |
| Scatter | two number columns | Drops rows with a missing value in either column |
| Line | any X column + number column | Sorts by X; if X repeats, plots the average Y |
| Histogram | one number column | Drops missing values; Plotly groups them into bins |

---

## 2. Project structure

```
DataViz-Project/
├── app.py              Flask backend (routes, Pandas processing, validation)
├── requirements.txt    Python packages
├── sample_data.csv     Demo file (36 rows of sales data, with a few missing values)
├── templates/
│   └── index.html      The single page
├── static/
│   ├── style.css       Styling and responsive layout
│   └── script.js       Upload, preview, column menus, Plotly charts
└── README.md
```

---

## 3. Setup on Windows

You need **Python 3.9 or newer** (check with `python --version`). Download it from python.org and tick **Add Python to PATH** during installation.

1. Open the project folder in **Command Prompt** (type `cmd` in the folder's address bar).
2. Create a virtual environment:
   ```
   python -m venv venv
   ```
3. Activate it:
   ```
   venv\Scripts\activate
   ```
   (In PowerShell, if this is blocked, run `Set-ExecutionPolicy -Scope Process Bypass` first, or just use Command Prompt.)
4. Install the packages:
   ```
   pip install -r requirements.txt
   ```
5. Start the server:
   ```
   python app.py
   ```
6. Open **http://127.0.0.1:5000** in your browser.

Stop the server with `Ctrl + C`.

> The page loads Plotly.js and the fonts from the internet (CDN), so you need to be online. If the fonts fail, the page falls back to Segoe UI.

---

## 4. Demo with the sample file

`sample_data.csv` has these columns: **Date, Region, Category, Units Sold, Revenue, Customer Rating**. It includes 3 missing values on purpose.

1. Drag `sample_data.csv` onto the upload area (or use **Choose file**), then click **Upload File**.
2. Point out the summary: 36 rows, 6 columns, 3 missing values, and the Number / Text / Date labels.
3. **Bar graph:** Category column `Region`, Value column `Revenue`, Calculate `Sum`, then **Generate Graph**. East is highest.
4. **Pie chart:** Category `Category`, Value `Revenue`. Electronics dominates revenue.
5. **Scatter plot:** X `Units Sold`, Y `Revenue`. Shows the positive relationship.
6. **Line graph:** X `Date`, Y `Revenue`. Shows the trend over the year (the average is plotted because each month has three regions).
7. **Histogram:** `Customer Rating`. Shows how ratings are spread.
8. Hover over the chart for tooltips, then click **Download PNG**.
9. Show error handling: try uploading a `.txt` file or an empty CSV.

**Prove the graphs use real data:** open `sample_data.csv` in Excel, change a Revenue value, upload it again, and regenerate the bar graph. The bar changes.

---

## 5. Security and data handling

- Only `.csv`, `.xlsx` and `.xls` are accepted, checked by extension **and** by file content (Excel files must have the right file signature, CSV must be plain text).
- Maximum file size is 5 MB and 100,000 rows (change `MAX_FILE_SIZE_MB` and `MAX_ROWS` in `app.py`).
- Uploaded files are **never saved to disk**. The data is kept in server memory as a DataFrame, forgotten after 30 idle minutes, and at most 50 uploads are held at once.
- Cell values are inserted with `textContent`, so a malicious cell cannot inject HTML or scripts.
- The server runs with `debug=False` and listens on `127.0.0.1` only (your own computer).

---

## 6. Likely viva questions

**Why does the server keep the DataFrame instead of sending the whole file back each time?**
Re-uploading on every chart would be slow. The server stores the table in memory and gives the browser a random token; later requests send only the token and column names.

**How are column types detected?**
Pandas gives each column a dtype. Text columns are then checked: if 90% or more of the values parse as numbers (or look like dates), the column is converted. See `guess_column_types()` in `app.py`.

**How are missing values handled?**
They are counted and shown after upload. Before each chart, rows missing a value in the chosen columns are dropped with `dropna()`, and the message under the chart says how many rows were used.

**Why a bar chart's "top 30" and a pie's "top 9 plus Other"?**
Charts with hundreds of categories are unreadable, so the app limits them and tells the user in a note.

**Why Plotly instead of Chart.js?**
Plotly supports all five chart types, has built-in tooltips, zoom and legends, and can export a PNG with one function call.

---

## 7. Troubleshooting

| Problem | Fix |
|---------|-----|
| `python` is not recognized | Reinstall Python and tick **Add Python to PATH**, or try `py` instead of `python`. |
| `Address already in use` | Another program uses port 5000. Change `port=5000` in the last line of `app.py` to `5001`. |
| Upload says "could not reach the server" | `python app.py` is not running, or it was stopped. |
| `.xls` file fails | Make sure `pip install -r requirements.txt` finished (it installs `xlrd`). Saving the file as `.xlsx` also works. |
| Charts do not appear, "chart library did not load" | You are offline. Plotly.js loads from the internet. |
| "Your uploaded data has expired" | The server was restarted or idle for 30 minutes. Upload the file again. |
