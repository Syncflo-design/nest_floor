# Nest Floor

Shop floor and site screens for a phone: scan, a number, one button. Desk page
`/desk/nest-floor` ("Shop Floor").

Requires `erpnext` only. Where `nest_projects` is installed the screens also
know each job's site store and can open a job on the Job Board; nothing here
imports it.

## Scanning

Every screen has one scan box. It takes:

- the **phone camera** (the camera button; QR codes and ordinary barcodes),
- a **hardware scanner** (it types the code and presses Enter),
- or a **typed** code or part of a name (close matches are offered).

What was scanned is identified first (job card, purchase order, item, in that
order), so a screen that expects an item says plainly when it was handed a job
card instead.

## Screens

Who sees what: the stock screens below show only to Stock User, Stock Manager,
Purchase User, Manufacturing User or System Manager. The Jobs screens show where
`nest_projects` is installed, to Projects User or Projects Manager. Someone with
only a projects role opens straight onto Jobs; someone with both gets a Jobs
tile on the stock home.

- **Jobs**: my open jobs (I am the responsible person), soonest due first, each
  with its stage, due date (overdue in red with a warning mark), and what is
  holding it up or else its next action. Type to find any job by number,
  customer or title; scan a job card to open it.
- **A job (Jobs)**: stage, responsible person, due date, what is holding it up
  (reason, who it is waiting on, details), the next action, and its materials
  (quantity, description, status, long-lead mark). A material still To Order or
  Ordered has one button, **Received**. That is the only write; stage moves and
  handovers stay on the Job Board, which it links to. Reads and the write go
  through `nest_projects`' own methods.
- **Home**: scan a job card to open the job, a purchase order to receive it, or
  an item to see where it is.
- **Receive**: open purchase orders, soonest due first. Scan items off the
  delivery (or tap a line), say how many arrived, add the supplier's delivery
  note, Book in. Creates a submitted Purchase Receipt from the order; each line
  goes to the warehouse on the order (a job's site store when the order was
  raised from the job).
- **Goods to site / Back to store**: pick the job, scan items into a list, Move.
  A Material Transfer tagged to the job, from the store (remembered per phone)
  to the job's site store, or back.
- **Used on site**: what was fitted, from the job's site store. A Material Issue
  against the job, which is what costs it. What is at site is listed to tap.
- **Find stock**: on hand per store (site stores show their job), and on order.
- **Print labels**: a sheet of QR labels for a job: its job card, its open
  purchase orders and the items it uses. Prints from its own window.

Every write is an ordinary ERPNext document, built and submitted with the
user's own permissions (Stock User can do all of it). Short stock is refused
with the item, the store and how many are there.

Not offline: each screen records as you tap the button.
