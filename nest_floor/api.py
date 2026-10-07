"""Shop floor and site screens: the server side.

The screens are a second front door onto ordinary ERPNext documents, shaped for a phone
in a glove: scan, a number, one button. Every write here builds the same document the
desk form would (a Purchase Receipt from the order, a Stock Entry tagged to the job) and
submits it with the user's own permissions, so nothing downstream can tell which door
it came through.

Where nest_projects is installed, a job (Project) has its own site store
(`job_warehouse`); the screens use it as the default. Nothing here imports that app.
"""

import io
import json

import frappe
from frappe import _
from frappe.utils import flt

# How many matches a search returns. A phone shows about six.
SEARCH_LIMIT = 20


# ---- guards and helpers -----------------------------------------------------


def _guard():
	"""Anyone who could neither receive nor move stock from the desk is refused here too.

	A whitelisted method is callable by any logged-in user, so the screens' own
	navigation is not a permission check.
	"""
	if not (frappe.has_permission("Stock Entry", "create") or frappe.has_permission("Purchase Receipt", "create")):
		frappe.throw(_("You do not have permission to use the shop floor screens."), frappe.PermissionError)


def _rows(rows):
	"""Lines arrive as JSON from the browser; keep those with an item and a quantity."""
	if isinstance(rows, str):
		rows = json.loads(rows)
	rows = [row for row in (rows or []) if row.get("item_code") and flt(row.get("qty")) > 0]
	if not rows:
		frappe.throw(_("Nothing to record. Add at least one item with a quantity."))
	return rows


def _has_jobs():
	"""nest_projects is installed: jobs have a stage and a site store."""
	return frappe.get_meta("Project").has_field("job_warehouse")


def _company(warehouse):
	company = frappe.db.get_value("Warehouse", warehouse, "company")
	if not company:
		frappe.throw(_("{0} is not a warehouse on this site.").format(warehouse))
	return company


def _qty(value):
	"""Quantities as people say them: 25, not 25.000."""
	return "{:g}".format(flt(value))


def _site_stores():
	"""Each job's site store -> the job, where nest_projects is installed."""
	if not _has_jobs():
		return {}
	return {
		row.job_warehouse: row.name
		for row in frappe.get_all("Project", filters={"job_warehouse": ["is", "set"]}, fields=["name", "job_warehouse"])
	}


def _main_store(company):
	"""Stock Settings' default if it belongs to the company, else its Stores, else any of its warehouses."""
	warehouse = frappe.db.get_single_value("Stock Settings", "default_warehouse")
	if warehouse and frappe.db.get_value("Warehouse", warehouse, "company") == company:
		return warehouse
	active = {"company": company, "is_group": 0, "disabled": 0}
	return frappe.db.get_value("Warehouse", {**active, "warehouse_name": "Stores"}, "name") or frappe.db.get_value(
		"Warehouse", active, "name"
	)


def _hit(kind, value, label, extra=None):
	found = {"type": kind, "value": value, "label": label}
	if extra:
		found.update(extra)
	return found


def _job_fields():
	fields = ["name", "project_name", "customer", "company", "status"]
	if _has_jobs():
		fields += ["job_stage", "job_site", "job_warehouse"]
	return fields


def _active_job_filters():
	filters = [["status", "=", "Open"]]
	if _has_jobs():
		filters.append(["job_stage", "is", "set"])
		closed = frappe.get_all("Job Stage", filters={"is_closed": 1}, pluck="name")
		if closed:
			filters.append(["job_stage", "not in", closed])
	return filters


def _on_hand(item_code, warehouse):
	return flt(frappe.db.get_value("Bin", {"item_code": item_code, "warehouse": warehouse}, "actual_qty"))


def _check_stock(warehouse, rows):
	"""Say which item is short, and by how much, before ERPNext's own refusal does."""
	wanted = {}
	for row in rows:
		wanted[row["item_code"]] = wanted.get(row["item_code"], 0) + flt(row["qty"])
	for item_code, qty in wanted.items():
		have = _on_hand(item_code, warehouse)
		if qty > have + 1e-9:
			frappe.throw(
				_("Only {0} of {1} in {2}, not {3}.").format(_qty(have), item_code, warehouse, _qty(qty))
			)


def _qr(value):
	"""A QR code as inline SVG (pyqrcode ships with Frappe). Phones read it through the camera."""
	import pyqrcode

	out = io.BytesIO()
	pyqrcode.create(value, error="M").svg(
		out, scale=4, quiet_zone=2, xmldecl=False, svgclass="nf-qr-svg", lineclass="nf-qr-line", omithw=True
	)
	return out.getvalue().decode("utf-8")


# ---- reading ------------------------------------------------------------------


@frappe.whitelist()
def bootstrap():
	"""Everything the screens need to open."""
	_guard()
	sites = _site_stores()
	warehouses = frappe.get_list(
		"Warehouse",
		filters={"is_group": 0, "disabled": 0},
		fields=["name", "warehouse_name", "company"],
		order_by="name asc",
		limit_page_length=0,
	)
	for row in warehouses:
		row["job"] = sites.get(row.name)
	companies = sorted({row.company for row in warehouses})
	return {
		"warehouses": warehouses,
		"main_stores": {company: _main_store(company) for company in companies},
		"has_jobs": _has_jobs(),
		"job_board": bool(frappe.db.exists("Page", "job-board")),
		"can_receive": bool(frappe.has_permission("Purchase Receipt", "create")),
		"can_move": bool(frappe.has_permission("Stock Entry", "create")),
	}


@frappe.whitelist()
def resolve_scan(term, warehouse=None):
	"""What a scanned or typed string is: a job card, a purchase order or an item.

	Screens decide what to do with the answer, including refusing a type they cannot
	use, but they refuse knowingly and can say what it actually was. Documents are
	checked before items because an item code is free text and could collide.
	"""
	_guard()
	term = (term or "").strip()
	if not term:
		return _hit("unknown", None, _("Nothing scanned."))

	job = frappe.db.get_value("Project", term, _job_fields(), as_dict=True)
	if job:
		return _hit("job", job.name, f"{job.name} · {job.project_name}", {"job": job})

	order = frappe.db.get_value(
		"Purchase Order", {"name": term, "docstatus": 1}, ["name", "supplier_name", "project"], as_dict=True
	)
	if order:
		return _hit("purchase_order", order.name, f"{order.name} · {order.supplier_name}", {"order": order})

	base = {"disabled": 0, "is_stock_item": 1}
	fields = ["name as item_code", "item_name", "stock_uom"]
	items = frappe.get_all("Item", filters=dict(base, name=term), fields=fields)
	if not items:
		coded = frappe.get_all("Item Barcode", filters={"barcode": term}, pluck="parent", limit=SEARCH_LIMIT)
		if coded:
			items = frappe.get_all("Item", filters=dict(base, name=["in", coded]), fields=fields)
	if len(items) == 1:
		item = items[0]
		if warehouse:
			item["actual_qty"] = _on_hand(item.item_code, warehouse)
		return _hit("item", item.item_code, f"{item.item_code} · {item.item_name}", {"item": item})
	if len(items) > 1:
		# One barcode on several items is a data fault, not a choice to make silently.
		return _hit("unknown", None, _("{0} is on more than one item.").format(term), {"suggestions": items})

	# Nothing matched exactly. Close matches are offered so a mistyped code is one tap
	# from right, but it is not a resolution.
	like = f"%{term}%"
	suggestions = frappe.get_all(
		"Item",
		filters=base,
		or_filters={"name": ["like", like], "item_name": ["like", like]},
		fields=fields,
		order_by="name asc",
		limit=SEARCH_LIMIT,
	)
	if warehouse:
		for item in suggestions:
			item["actual_qty"] = _on_hand(item.item_code, warehouse)
	jobs = frappe.get_list(
		"Project",
		filters=_active_job_filters(),
		or_filters={"name": ["like", like], "project_name": ["like", like]},
		fields=_job_fields(),
		order_by="name desc",
		limit_page_length=5,
	)
	return _hit("unknown", None, _("Nothing matches {0}.").format(term), {"suggestions": suggestions, "jobs": jobs})


@frappe.whitelist()
def jobs(term=None):
	"""Jobs that are on the go, newest first."""
	_guard()
	or_filters = None
	if (term or "").strip():
		like = f"%{term.strip()}%"
		or_filters = {"name": ["like", like], "project_name": ["like", like], "customer": ["like", like]}
	return frappe.get_list(
		"Project",
		filters=_active_job_filters(),
		or_filters=or_filters,
		fields=_job_fields(),
		order_by="name desc",
		limit_page_length=50,
	)


@frappe.whitelist()
def job(name):
	"""One job, with what is at its site store now."""
	_guard()
	frappe.has_permission("Project", "read", name, throw=True)
	doc = frappe.db.get_value("Project", name, _job_fields(), as_dict=True)
	if not doc:
		frappe.throw(_("{0} is not a job on this site.").format(name))
	doc["on_site"] = _bins(doc.get("job_warehouse")) if doc.get("job_warehouse") else []
	return doc


def _bins(warehouse):
	bins = frappe.get_all(
		"Bin",
		filters={"warehouse": warehouse, "actual_qty": [">", 0]},
		fields=["item_code", "actual_qty"],
		order_by="item_code asc",
	)
	if not bins:
		return []
	items = {
		row.name: row
		for row in frappe.get_all(
			"Item", filters={"name": ["in", [b.item_code for b in bins]]}, fields=["name", "item_name", "stock_uom"]
		)
	}
	return [
		{
			"item_code": b.item_code,
			"item_name": items[b.item_code].item_name if b.item_code in items else b.item_code,
			"stock_uom": items[b.item_code].stock_uom if b.item_code in items else None,
			"qty": b.actual_qty,
		}
		for b in bins
	]


@frappe.whitelist()
def stock_for(item_code):
	"""Where an item is and how much: on hand per store, and what is on order."""
	_guard()
	item = frappe.db.get_value("Item", item_code, ["name", "item_name", "stock_uom", "image"], as_dict=True)
	if not item:
		frappe.throw(_("{0} is not an item on this site.").format(item_code))
	sites = _site_stores()
	bins = frappe.get_all(
		"Bin",
		filters={"item_code": item_code},
		fields=["warehouse", "actual_qty", "ordered_qty", "reserved_qty"],
		order_by="actual_qty desc",
	)
	rows = [
		{
			"warehouse": b.warehouse,
			"qty": flt(b.actual_qty),
			"ordered": flt(b.ordered_qty),
			"reserved": flt(b.reserved_qty),
			"job": sites.get(b.warehouse),
		}
		for b in bins
		if flt(b.actual_qty) or flt(b.ordered_qty)
	]
	return {
		"item_code": item.name,
		"item_name": item.item_name,
		"stock_uom": item.stock_uom,
		"image": item.image,
		"rows": rows,
		"on_hand": sum(r["qty"] for r in rows),
		"on_order": sum(r["ordered"] for r in rows),
	}


@frappe.whitelist()
def open_orders(term=None):
	"""Submitted purchase orders still waiting for goods, soonest due first."""
	_guard()
	or_filters = None
	if (term or "").strip():
		like = f"%{term.strip()}%"
		or_filters = {"name": ["like", like], "supplier_name": ["like", like], "project": ["like", like]}
	orders = frappe.get_list(
		"Purchase Order",
		filters=[["docstatus", "=", 1], ["per_received", "<", 100], ["status", "not in", ["Closed", "On Hold", "Completed"]]],
		or_filters=or_filters,
		fields=["name", "supplier_name", "project", "schedule_date", "per_received"],
		order_by="schedule_date asc",
		limit_page_length=50,
	)
	titles = dict(
		frappe.get_all(
			"Project",
			filters={"name": ["in", [o.project for o in orders if o.project]]},
			fields=["name", "project_name"],
			as_list=True,
		)
	) if any(o.project for o in orders) else {}
	for order in orders:
		order["project_name"] = titles.get(order.project)
	return orders


@frappe.whitelist()
def order_lines(purchase_order):
	"""What this order is still owed, line by line (the same item can be on it twice)."""
	_guard()
	order = frappe.get_doc("Purchase Order", purchase_order)
	order.check_permission("read")
	if order.docstatus != 1:
		frappe.throw(_("{0} has not been submitted yet. Goods can be booked in once buying submits it.").format(order.name))
	lines = []
	for row in order.items:
		lines.append(
			{
				"purchase_order_item": row.name,
				"idx": row.idx,
				"item_code": row.item_code,
				"item_name": row.item_name,
				"ordered": flt(row.qty),
				"received": flt(row.received_qty),
				"outstanding": max(flt(row.qty) - flt(row.received_qty), 0),
				"uom": row.uom,
				"warehouse": row.warehouse,
			}
		)
	return {
		"name": order.name,
		"supplier_name": order.supplier_name,
		"project": order.project,
		"project_name": frappe.db.get_value("Project", order.project, "project_name") if order.project else None,
		"schedule_date": order.schedule_date,
		"lines": lines,
	}


@frappe.whitelist()
def labels(job):
	"""Printable QR labels for a job: its job card, its open orders and the items it uses."""
	_guard()
	frappe.has_permission("Project", "read", job, throw=True)
	doc = frappe.get_doc("Project", job)

	orders = frappe.get_all(
		"Purchase Order",
		filters={"project": job, "docstatus": 1, "per_received": ["<", 100]},
		fields=["name", "supplier_name"],
		order_by="name asc",
	)

	codes = []
	for row in doc.get("job_materials") or []:
		if row.get("item"):
			codes.append(row.item)
	if orders:
		codes += frappe.get_all("Purchase Order Item", filters={"parent": ["in", [o.name for o in orders]]}, pluck="item_code")
	if doc.get("job_warehouse"):
		codes += [b["item_code"] for b in _bins(doc.job_warehouse)]
	codes = list(dict.fromkeys(codes))[:40]
	names = dict(frappe.get_all("Item", filters={"name": ["in", codes]}, fields=["name", "item_name"], as_list=True)) if codes else {}

	return {
		"job": {
			"name": doc.name,
			"project_name": doc.project_name,
			"customer": doc.customer,
			"site": doc.get("job_site"),
			"qr": _qr(doc.name),
		},
		"orders": [{"name": o.name, "supplier_name": o.supplier_name, "qr": _qr(o.name)} for o in orders],
		"items": [{"item_code": c, "item_name": names.get(c), "qr": _qr(c)} for c in codes if c in names],
	}


# ---- writing ------------------------------------------------------------------


@frappe.whitelist()
def receive(purchase_order, rows, supplier_delivery_note=None):
	"""Book a delivery in: a Purchase Receipt from the order, for what actually arrived.

	Each line goes to the warehouse the order says (a job's site store when the order
	was raised from the job), and carries the order's project.
	"""
	if not frappe.has_permission("Purchase Receipt", "create"):
		frappe.throw(_("You do not have permission to book deliveries in."), frappe.PermissionError)
	from erpnext.buying.doctype.purchase_order.purchase_order import make_purchase_receipt

	wanted = {}
	for row in _rows_by_line(rows):
		wanted[row["purchase_order_item"]] = wanted.get(row["purchase_order_item"], 0) + flt(row["qty"])

	ordered = {
		row.name: row
		for row in frappe.get_all(
			"Purchase Order Item",
			filters={"parent": purchase_order, "name": ["in", list(wanted)]},
			fields=["name", "item_code", "qty", "received_qty", "uom"],
		)
	}
	for line, qty in wanted.items():
		row = ordered.get(line)
		if not row:
			frappe.throw(_("A line booked in is not on {0}.").format(purchase_order))
		outstanding = flt(row.qty) - flt(row.received_qty)
		if qty > outstanding + 1e-9:
			frappe.throw(
				_("Only {0} {1} of {2} still to come on {3}.").format(_qty(outstanding), row.uom, row.item_code, purchase_order)
			)

	receipt = make_purchase_receipt(purchase_order)
	receipt.items = [row for row in receipt.items if row.purchase_order_item in wanted]
	for idx, row in enumerate(receipt.items, 1):
		row.idx = idx
		row.qty = wanted[row.purchase_order_item]
		row.received_qty = row.qty
		row.rejected_qty = 0
	if (supplier_delivery_note or "").strip():
		receipt.supplier_delivery_note = supplier_delivery_note.strip()
	receipt.insert()
	receipt.submit()
	return {"name": receipt.name, "lines": len(receipt.items)}


def _rows_by_line(rows):
	if isinstance(rows, str):
		rows = json.loads(rows)
	rows = [row for row in (rows or []) if row.get("purchase_order_item") and flt(row.get("qty")) > 0]
	if not rows:
		frappe.throw(_("Nothing booked in yet. Scan or tap an item and enter how many arrived."))
	return rows


@frappe.whitelist()
def move(from_warehouse, to_warehouse, rows, job=None, note=None):
	"""Goods from one store to another: to a job's site, or back to the store."""
	if not frappe.has_permission("Stock Entry", "create"):
		frappe.throw(_("You do not have permission to move stock."), frappe.PermissionError)
	if not from_warehouse or not to_warehouse:
		frappe.throw(_("Choose where the goods come from and where they go."))
	if from_warehouse == to_warehouse:
		frappe.throw(_("From and to are the same store."))
	company = _company(from_warehouse)
	if _company(to_warehouse) != company:
		frappe.throw(_("{0} and {1} belong to different companies.").format(from_warehouse, to_warehouse))
	rows = _rows(rows)
	_check_stock(from_warehouse, rows)

	entry = _entry("Material Transfer", company, job, note)
	for row in rows:
		entry.append(
			"items",
			{
				"item_code": row["item_code"],
				"qty": flt(row["qty"]),
				"s_warehouse": from_warehouse,
				"t_warehouse": to_warehouse,
				"project": job or None,
			},
		)
	entry.insert()
	entry.submit()
	return {"name": entry.name}


@frappe.whitelist()
def use(job, warehouse, rows, note=None):
	"""What was used on site: issued from the store against the job, which costs the job."""
	if not frappe.has_permission("Stock Entry", "create"):
		frappe.throw(_("You do not have permission to move stock."), frappe.PermissionError)
	if not job:
		frappe.throw(_("Choose the job the goods were used on."))
	if not warehouse:
		frappe.throw(_("Choose the store the goods were used from."))
	rows = _rows(rows)
	_check_stock(warehouse, rows)

	entry = _entry("Material Issue", _company(warehouse), job, note)
	for row in rows:
		entry.append(
			"items", {"item_code": row["item_code"], "qty": flt(row["qty"]), "s_warehouse": warehouse, "project": job}
		)
	entry.insert()
	entry.submit()
	return {"name": entry.name}


def _entry(purpose, company, job, note):
	if job:
		frappe.has_permission("Project", "read", job, throw=True)
		job_company = frappe.db.get_value("Project", job, "company")
		if job_company and job_company != company:
			frappe.throw(_("{0} belongs to {1}, not {2}.").format(job, job_company, company))
	entry = frappe.new_doc("Stock Entry")
	entry.stock_entry_type = purpose
	entry.company = company
	entry.project = job or None
	entry.remarks = (note or "").strip() or (
		_("{0} for {1} (shop floor)").format(_(purpose), job) if job else _("{0} (shop floor)").format(_(purpose))
	)
	return entry
