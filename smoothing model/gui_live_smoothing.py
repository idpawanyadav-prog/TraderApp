import tkinter as tk
from tkinter import ttk, messagebox
import xlwings as xw
import numpy as np
import json, threading, time
import pythoncom
from smoothing_models import apply_model

# ================= CONFIG =================
DEFAULT_WBK = "LiveInstrumentData.xlsx"
DEFAULT_WKS = "SMALL DATA"
CHECK_INTERVAL = 60
MIN_ROWS = 11
PRESET_FILE = "preset.json"
# ========================================

MODELS = ["None", "Savitzky-Golay", "Gaussian Kernel", "Kernel Poly"]

INPUT_RULES = {
    1: ["Price"],
    2: ["Price", "AC_CE1"],
    3: ["Price", "AC_CE1", "AC_CE2"],
    4: ["Price", "AC_CE1", "AC_CE2", "AC_CE3"]
}

EXCEL_COLS = {1: "C", 2: "D", 3: "E", 4: "F"}

DEFAULT_PARAMS = {
    "Savitzky-Golay": {"window": 11, "polyorder": 3},
    "Gaussian Kernel": {"bandwidth": 3.0},
    "Kernel Poly": {"degree": 2, "bandwidth": 8},
    "None": {}
}


class SmoothingGUI:
    def __init__(self, root):
        self.root = root
        self.root.title("Live Excel Smoothing (Thread Safe)")

        self.rows = {}
        self.workbook_name = None
        self.sheet_name = None

        self.is_paused = False
        self.force_recalc = False
        self.engine_thread = None
        self.recalc_event = threading.Event()

        self.build_excel_selector()
        self.build_header()
        for lvl in range(1, 5):
            self.build_row(lvl)
        self.build_buttons()

        self.load_open_workbooks()

    # ---------- Excel selector ----------
    def build_excel_selector(self):
        frame = ttk.LabelFrame(self.root, text="Excel Selection")
        frame.grid(row=0, column=0, columnspan=5, padx=6, pady=6, sticky="w")

        ttk.Label(frame, text="Workbook").grid(row=0, column=0)
        self.wbk_var = tk.StringVar()
        self.wbk_cb = ttk.Combobox(frame, textvariable=self.wbk_var, width=30, state="readonly")
        self.wbk_cb.grid(row=0, column=1, padx=5)
        self.wbk_cb.bind("<<ComboboxSelected>>", self.on_workbook_selected)

        ttk.Label(frame, text="Worksheet").grid(row=0, column=2)
        self.wks_var = tk.StringVar()
        self.wks_cb = ttk.Combobox(frame, textvariable=self.wks_var, width=20, state="readonly")
        self.wks_cb.grid(row=0, column=3, padx=5)
        self.wks_cb.bind("<<ComboboxSelected>>", self.on_sheet_selected)

    def load_open_workbooks(self):
        try:
            app = xw.apps.active
            books = [b.name for b in app.books]
            self.wbk_cb["values"] = books

            if DEFAULT_WBK in books:
                self.wbk_var.set(DEFAULT_WBK)
            elif books:
                self.wbk_var.set(books[0])

            self.on_workbook_selected()
        except:
            messagebox.showerror("Excel", "No open Excel instance found")

    def on_workbook_selected(self, event=None):
        self.workbook_name = self.wbk_var.get()
        app = xw.apps.active
        wb = next(b for b in app.books if b.name == self.workbook_name)

        sheets = [s.name for s in wb.sheets]
        self.wks_cb["values"] = sheets

        if DEFAULT_WKS in sheets:
            self.wks_var.set(DEFAULT_WKS)
        else:
            self.wks_var.set(sheets[0])

        self.on_sheet_selected()

    def on_sheet_selected(self, event=None):
        self.sheet_name = self.wks_var.get()
        self.recalc_event.set()

    # ---------- UI ----------
    def build_header(self):
        headers = ["Level", "Enable", "Input", "Model", "Parameters"]
        for c, h in enumerate(headers):
            ttk.Label(self.root, text=h, font=("Segoe UI", 9, "bold")) \
                .grid(row=1, column=c, padx=6)

    def build_row(self, level):
        r = level + 1
        ttk.Label(self.root, text=f"CE{level}").grid(row=r, column=0)

        enable = tk.BooleanVar(value=True)
        ttk.Checkbutton(self.root, variable=enable).grid(row=r, column=1)

        input_var = tk.StringVar(value=INPUT_RULES[level][-1])
        ttk.Combobox(self.root, values=INPUT_RULES[level],
                     textvariable=input_var, width=12,
                     state="readonly").grid(row=r, column=2)

        model = tk.StringVar(value="Savitzky-Golay")
        ttk.Combobox(self.root, values=MODELS,
                     textvariable=model, width=18,
                     state="readonly").grid(row=r, column=3)

        pf = ttk.Frame(self.root)
        pf.grid(row=r, column=4, sticky="w")

        self.rows[level] = {
            "enabled": enable,
            "input": input_var,
            "model": model,
            "params": DEFAULT_PARAMS[model.get()].copy(),
            "param_frame": pf
        }

        model.trace_add("write", lambda *_ , lvl=level: self.on_model_change(lvl))
        self.render_params(level)

    def on_model_change(self, level):
        model = self.rows[level]["model"].get()
        self.rows[level]["params"] = DEFAULT_PARAMS[model].copy()
        self.render_params(level)
        self.recalc_event.set()

    def render_params(self, level):
        row = self.rows[level]
        for w in row["param_frame"].winfo_children():
            w.destroy()

        for c, (k, v) in enumerate(row["params"].items()):
            ttk.Label(row["param_frame"], text=k).grid(row=0, column=c)
            e = ttk.Entry(row["param_frame"], width=6)
            e.insert(0, str(v))
            e.grid(row=1, column=c)
            e.bind("<KeyRelease>",
                   lambda ev, key=k, lvl=level:
                   self.update_param(lvl, key, ev.widget.get()))

    def update_param(self, level, key, value):
        try:
            self.rows[level]["params"][key] = float(value) if "." in value else int(value)
            self.recalc_event.set()
        except:
            pass

    # ---------- Buttons ----------
    def build_buttons(self):
        r = 7
        ttk.Button(self.root, text="▶ Start / Recalculate", command=self.start).grid(row=r, column=0)
        self.pause_btn = ttk.Button(self.root, text="⏸ Pause", command=self.toggle_pause)
        self.pause_btn.grid(row=r, column=1)
        ttk.Button(self.root, text="💾 Save Preset", command=self.save_preset).grid(row=r, column=2)
        ttk.Button(self.root, text="📂 Load Preset", command=self.load_preset).grid(row=r, column=3)

    # ---------- Control ----------
    def toggle_pause(self):
        self.is_paused = not self.is_paused
        self.pause_btn.config(text="▶ Resume" if self.is_paused else "⏸ Pause")
        if not self.is_paused:
            self.recalc_event.set()

    def start(self):
        self.force_recalc = True
        self.is_paused = False
        self.pause_btn.config(text="⏸ Pause")
        self.recalc_event.set()

        if self.engine_thread and self.engine_thread.is_alive():
            return

        self.engine_thread = threading.Thread(target=self.run_engine, daemon=True)
        self.engine_thread.start()

    # ---------- ENGINE (THREAD SAFE) ----------
    def run_engine(self):
        pythoncom.CoInitialize()
        try:
            while True:
                if self.is_paused and not self.force_recalc:
                    self.recalc_event.wait(1)
                    self.recalc_event.clear()
                    continue

                try:
                    app = xw.apps.active
                    wb = next(b for b in app.books if b.name == self.workbook_name)
                    sheet = wb.sheets[self.sheet_name]

                    last_row = sheet.range(
                        "B" + str(sheet.cells.last_cell.row)
                    ).end("up").row

                    if last_row - 1 < MIN_ROWS:
                        self.recalc_event.wait(5)
                        self.recalc_event.clear()
                        continue

                    data = {
                        "Price": np.array(sheet.range(f"B2:B{last_row}").value, float)
                    }

                    existing = {}
                    for lvl, col in EXCEL_COLS.items():
                        vals = sheet.range(f"{col}2:{col}{last_row}").value
                        existing[f"AC_CE{lvl}"] = (
                            np.array([v if v is not None else np.nan for v in vals], float)
                            if vals and any(v is not None for v in vals)
                            else None
                        )

                    for lvl in range(1, 5):
                        r = self.rows[lvl]
                        key = f"AC_CE{lvl}"

                        if not r["enabled"].get():
                            data[key] = existing[key] if existing[key] is not None else data[r["input"].get()]
                        else:
                            data[key] = apply_model(
                                data[r["input"].get()],
                                r["model"].get(),
                                r["params"]
                            )

                    for lvl in range(1, 5):
                        if self.rows[lvl]["enabled"].get():
                            sheet.range(f"{EXCEL_COLS[lvl]}2") \
                                .options(transpose=True).value = data[f"AC_CE{lvl}"]

                    self.force_recalc = False
                    self.recalc_event.wait(CHECK_INTERVAL)
                    self.recalc_event.clear()

                except Exception as e:
                    print("Waiting...", e)
                    self.recalc_event.wait(5)
                    self.recalc_event.clear()
        finally:
            pythoncom.CoUninitialize()

    # ---------- Presets ----------
    def save_preset(self):
        with open(PRESET_FILE, "w") as f:
            json.dump({
                lvl: {
                    "enabled": r["enabled"].get(),
                    "input": r["input"].get(),
                    "model": r["model"].get(),
                    "params": dict(r["params"])
                } for lvl, r in self.rows.items()
            }, f, indent=2)
        messagebox.showinfo("Preset", "Preset saved")

    def load_preset(self):
        try:
            with open(PRESET_FILE) as f:
                data = json.load(f)
            for lvl, cfg in data.items():
                lvl = int(lvl)
                self.rows[lvl]["enabled"].set(cfg["enabled"])
                self.rows[lvl]["input"].set(cfg["input"])
                self.rows[lvl]["model"].set(cfg["model"])
                self.rows[lvl]["params"] = dict(cfg["params"])
                self.render_params(lvl)
            self.recalc_event.set()
            messagebox.showinfo("Preset", "Preset loaded")
        except Exception as e:
            messagebox.showerror("Error", str(e))


if __name__ == "__main__":
    root = tk.Tk()
    app = SmoothingGUI(root)
    root.mainloop()
