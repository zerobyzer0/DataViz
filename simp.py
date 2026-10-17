import pandas as pd
import matplotlib.pyplot as plt
import seaborn as sns
from google.colab import files
from IPython.display import display

# ---------- 1. Upload your file ----------
print("Upload your .csv or .xlsx file:")
uploaded = files.upload()
file_path = list(uploaded.keys())[0]
print(f"\n--- Starting Analysis for {file_path} ---\n")

# ---------- 2. Load ----------
if file_path.lower().endswith(".csv"):
    df = pd.read_csv(file_path)
elif file_path.lower().endswith((".xlsx", ".xls")):
    df = pd.read_excel(file_path)
else:
    raise ValueError("Unsupported format. Upload a .csv or .xlsx file.")

# ---------- 3. Overview ----------
print("### 1. Shape ###")
print(f"Rows: {df.shape[0]}, Columns: {df.shape[1]}\n")

print("### 2. Column Names & Data Types ###")
print(df.dtypes, "\n")

print("### 3. First 5 Rows ###")
display(df.head())

print("\n### 4. Missing Values ###")
missing = df.isnull().sum()
print(missing[missing > 0] if missing.sum() > 0 else "No missing values found!")

print("\n### 5. Summary Statistics ###")
display(df.describe())

# ---------- 4. General visualizations (Output 1) ----------
numeric_cols = df.select_dtypes(include="number").columns
print("\n### 6. General Visualizations ###")

if len(numeric_cols) >= 2:
    plt.figure(figsize=(8, 6))
    sns.heatmap(df[numeric_cols].corr(), annot=True, cmap="coolwarm", fmt=".2f")
    plt.title("Correlation Heatmap of Numeric Variables")
    plt.tight_layout()
    plt.savefig("correlation_heatmap.png")
    plt.show()

if len(numeric_cols) >= 1:
    plt.figure(figsize=(8, 5))
    sns.histplot(df[numeric_cols[0]], kde=True, color="skyblue")
    plt.title(f"Distribution of {numeric_cols[0]}")
    plt.tight_layout()
    plt.savefig("data_distribution.png")
    plt.show()
else:
    print("No numeric columns found for general plots.")

# ---------- 5. Budget pie chart (Output 2) ----------
category_col = next((c for c in df.columns if "category" in c.lower()), None)
amount_col = next(
    (c for c in df.columns
     if any(k in c.lower() for k in ["amount", "value", "price"])
     and pd.api.types.is_numeric_dtype(df[c])),
    None,
)

if category_col and amount_col:
    print(f"\n### 7. Budget Data Detected: '{category_col}' by '{amount_col}' ###")

    budget = df.groupby(category_col)[amount_col].sum()
    budget = budget[budget > 0].sort_values(ascending=False)  # pie can't show negatives

    # Merge small slices into "Other" so the chart stays readable
    if len(budget) > 8:
        top = budget.iloc[:7]
        top["Other"] = budget.iloc[7:].sum()
        budget = top

    pct = budget / budget.sum() * 100
    print("--- Weighted Percentage Breakdown ---")
    for cat, p in pct.items():
        print(f"{cat}: {p:.2f}%  (Total: ₹{budget[cat]:,.2f})")

    fig, ax = plt.subplots(figsize=(10, 8))
    ax.pie(
        budget,
        labels=budget.index,
        autopct="%1.1f%%",
        startangle=90,
        colors=sns.color_palette("pastel", len(budget)),
        wedgeprops={"edgecolor": "white", "linewidth": 2},
    )
    ax.axis("equal")
    plt.title(f"Budget Distribution ({category_col} by {amount_col})", fontsize=16, pad=20)
    plt.tight_layout()
    plt.savefig("budget_pie_chart.png")
    plt.show()
else:
    print("\n(No category + amount columns detected, so no pie chart.)")