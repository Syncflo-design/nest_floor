// nest_floor — shop floor and site screens for a phone.
//
// Scan, a number, one button. Every screen ends in an ordinary ERPNext document built
// by nest_floor/api.py with the user's own permissions: a Purchase Receipt from the
// order, or a Stock Entry tagged to the job. Scans come from the phone camera
// (frappe.ui.Scanner), a hardware scanner (it types the code and presses Enter) or the
// keyboard; all three land in the same handler.
//
// Desk Page: mounts inside page.body (jQuery in v16, CoWork_Helper gotcha 2026-05-10).
// HTML is built as string arrays joined with "\n" (page-bundle rule).
// Bump BUILD_MARKER with every CSS change (gotcha 2026-08-18).

frappe.pages['nest-floor'].on_page_load = function(wrapper) {
	var page = frappe.ui.make_app_page({ parent: wrapper, title: __('Shop Floor'), single_column: true });

	var BUILD_MARKER = 'v0.0.1-2026-10-07-first';
	console.log('Shop Floor loaded:', BUILD_MARKER);

	[
		['nf-stylesheet', '/assets/nest_floor/css/nest_floor.css'],
		['nf-phosphor', '/assets/nest_floor/vendor/phosphor/style.css']
	].forEach(function(css) {
		if (document.getElementById(css[0])) return;
		var link = document.createElement('link');
		link.id = css[0];
		link.rel = 'stylesheet';
		link.href = css[1] + '?v=' + encodeURIComponent(BUILD_MARKER);
		document.head.appendChild(link);
	});

	wrapper.nestFloor = new NestFloor(page);
};

frappe.pages['nest-floor'].on_page_show = function(wrapper) {
	if (wrapper.nestFloor) wrapper.nestFloor.on_show();
};

// ---------------------------------------------------------------------------

var NF_API = 'nest_floor.api.';

// The label sheet on paper: cut lines, nothing split across a page.
var NF_PRINT_CSS = [
	'body { font-family: -apple-system, "Segoe UI", Roboto, Arial, sans-serif; color: #111; margin: 0; }',
	'@page { margin: 10mm; }',
	'.nf-sheet-head { margin: 12px 0 6px; font-size: 11px; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; color: #555; }',
	'.nf-label-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 6mm; }',
	'.nf-label-card { display: flex; align-items: center; gap: 4mm; padding: 3mm; border: 1px dashed #999; break-inside: avoid; }',
	'.nf-qr { width: 28mm; height: 28mm; flex: 0 0 28mm; }',
	'.nf-label-job .nf-qr { width: 45mm; height: 45mm; flex-basis: 45mm; }',
	'.nf-qr svg { width: 100%; height: 100%; display: block; }',
	'.nf-label-big { font-size: 15pt; font-weight: 800; word-break: break-word; }',
	'.nf-label-job .nf-label-big { font-size: 24pt; }',
	'.nf-label-small { font-size: 9pt; color: #333; word-break: break-word; }'
].join('\n');

function nf_esc(s) {
	var map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
	return String(s == null ? '' : s).replace(/[&<>"']/g, function(c) { return map[c]; });
}

// Quantities as people say them: 25, not 25.000.
function nf_qty(value) {
	return String(parseFloat(flt(value).toFixed(4)));
}

function nf_icon(name) {
	return '<i class="ph ph-' + name + '" aria-hidden="true"></i>';
}

// The store someone picked last, per company and side, so the second move of a shift is
// three taps. A locked-down browser is not a reason to stop working.
function nf_remembered(key) {
	try { return localStorage.getItem('nest-floor:' + key) || ''; } catch (e) { return ''; }
}

function nf_remember(key, value) {
	try { localStorage.setItem('nest-floor:' + key, value || ''); } catch (e) { /* storage blocked */ }
}

function nf_call(method, args, freeze) {
	return frappe.call({
		method: NF_API + method,
		args: args || {},
		freeze: !!freeze,
		freeze_message: freeze ? __('Recording...') : undefined
	}).then(function(r) { return r.message; });
}

class NestFloor {

	constructor(page) {
		this.page = page;
		this.ctx = null;
		this.basket = [];
		this.$root = $('<div class="nf-root"></div>').appendTo(page.body);
		var $head = page.head ? $(page.head) : $(page.wrapper).find('.page-head');
		if ($head && $head.length) $head.hide();
		this.load().then(() => this.open_route());
	}

	load() {
		return nf_call('bootstrap').then((ctx) => { this.ctx = ctx; });
	}

	on_show() {
		if (this.ctx) this.load();
	}

	// nest-floor/receive, /to-site, /used, /find or /labels opens that screen (home tiles link here).
	open_route() {
		var asked = (frappe.get_route() || [])[1];
		if (asked === 'receive') this.receive_list();
		else if (asked === 'to-site') this.pick_job(__('Goods to site'), (job) => this.move(job, 'to'));
		else if (asked === 'used') this.pick_job(__('Used on site'), (job) => this.use(job));
		else if (asked === 'find') this.find();
		else if (asked === 'labels') this.pick_job(__('Print labels'), (job) => this.labels(job.name));
		else this.home();
	}

	// ---- building blocks ---------------------------------------------------

	render(html) {
		this.$root.html(html);
		window.scrollTo(0, 0);
	}

	head(title, sub, back) {
		return [
			'<div class="nf-head">',
			back ? '  <button class="nf-back" data-back="1" aria-label="' + __('Back') + '">' + nf_icon('arrow-left') + '</button>' : '',
			'  <div class="nf-head-text">',
			'    <div class="nf-title">' + nf_esc(title) + '</div>',
			sub ? '    <div class="nf-sub">' + nf_esc(sub) + '</div>' : '',
			'  </div>',
			'</div>'
		].join('\n');
	}

	bind_back(handler) {
		this.$root.find('[data-back]').on('click', handler);
	}

	can_camera() {
		return !!(frappe.ui && frappe.ui.Scanner);
	}

	scan_box(placeholder) {
		return [
			'<div class="nf-scan">',
			'  <span class="nf-scan-mark">' + nf_icon('barcode') + '</span>',
			'  <input class="nf-input" data-scan="1" placeholder="' + nf_esc(placeholder) + '"',
			'         autocomplete="off" autocapitalize="characters" spellcheck="false" enterkeyhint="go">',
			this.can_camera() ? '  <button class="nf-camera" data-camera="1" aria-label="' + __('Scan with the camera') + '">' + nf_icon('camera') + '</button>' : '',
			'</div>'
		].join('\n');
	}

	// Hardware scanners type the code and press Enter; so do people. The camera feeds the same handler.
	bind_scan(handler, on_input) {
		var $scan = this.$root.find('[data-scan]');
		$scan.on('keydown', function(e) {
			if (e.key !== 'Enter') return;
			e.preventDefault();
			var term = ($scan.val() || '').trim();
			$scan.val('');
			if (term) handler(term);
		});
		if (on_input) $scan.on('input', function() { on_input(($scan.val() || '').trim()); });
		this.$root.find('[data-camera]').on('click', () => this.camera(handler));
		// Not on phones: the keyboard would cover the screen before anything is scanned.
		if (!frappe.is_mobile()) $scan.trigger('focus');
	}

	camera(handler) {
		new frappe.ui.Scanner({
			dialog: true,
			multiple: false,
			on_scan: function(data) {
				var text = data && (data.decodedText || (data.result && data.result.text));
				if (text) handler(String(text).trim());
			}
		});
	}

	focus_scan() {
		if (!frappe.is_mobile()) this.$root.find('[data-scan]').val('').trigger('focus');
	}

	say(message, tone) {
		frappe.show_alert({ message: nf_esc(message), indicator: tone || 'orange' }, 5);
	}

	// One tile on the home screen.
	tile(go, icon, title, blurb) {
		return [
			'<button class="nf-tile" data-go="' + go + '">',
			'  <span class="nf-tile-mark">' + nf_icon(icon) + '</span>',
			'  <span class="nf-tile-text">',
			'    <span class="nf-tile-title">' + nf_esc(title) + '</span>',
			'    <span class="nf-tile-sub">' + nf_esc(blurb) + '</span>',
			'  </span>',
			'  <span class="nf-tile-go">' + nf_icon('arrow-right') + '</span>',
			'</button>'
		].join('\n');
	}

	row(attrs, main, sub, right) {
		return [
			'<button class="nf-row" ' + attrs + '>',
			'  <span class="nf-row-main">' + main + '</span>',
			sub ? '  <span class="nf-row-sub">' + sub + '</span>' : '',
			right ? '  <span class="nf-row-right">' + right + '</span>' : '',
			'</button>'
		].join('\n');
	}

	// How many: a dialog with one number in it. opts: default, max, max_text, info, label.
	ask_qty(item, opts, done) {
		var me = this;
		opts = opts || {};
		var d = new frappe.ui.Dialog({
			title: item.item_code,
			fields: [
				{ fieldtype: 'HTML', fieldname: 'info' },
				{ fieldtype: 'Float', fieldname: 'qty', label: opts.label || __('How many?'), reqd: 1, default: opts.default || 1 }
			],
			primary_action_label: opts.action || __('Add'),
			primary_action: function(values) {
				var qty = flt(values.qty);
				if (qty <= 0) { me.say(__('Enter a quantity above zero.'), 'red'); return; }
				if (opts.max != null && qty > flt(opts.max) + 1e-9) {
					me.say(opts.max_text || __('Only {0} available.', [nf_qty(opts.max)]), 'red');
					return;
				}
				d.hide();
				done(qty);
			}
		});
		d.fields_dict.info.$wrapper.html([
			'<div class="nf-ask">',
			'  <div class="nf-ask-name">' + nf_esc(item.item_name || item.item_code) + '</div>',
			opts.info ? '  <div class="nf-ask-info">' + opts.info + '</div>' : '',
			'</div>'
		].join('\n'));
		d.on_hide = function() { me.focus_scan(); };
		d.show();
		setTimeout(function() { d.get_field('qty').$input.trigger('focus').trigger('select'); }, 250);
	}

	done(message, ref, actions) {
		this.render([
			'<div class="nf-done">',
			'  <span class="nf-tick">' + nf_icon('check') + '</span>',
			'  <div class="nf-done-msg">' + nf_esc(message) + '</div>',
			ref ? '  <div class="nf-done-ref">' + nf_esc(ref) + '</div>' : '',
			'</div>',
			'<div class="nf-stack">',
			actions.map(function(a, i) {
				return '<button class="' + (a.primary ? 'nf-submit' : 'nf-secondary') + '" data-action="' + i + '">' + nf_esc(a.label) + '</button>';
			}).join('\n'),
			'</div>'
		].join('\n'));
		this.$root.find('[data-action]').on('click', function() { actions[+$(this).attr('data-action')].fn(); });
	}

	stores(company, exclude_sites) {
		return (this.ctx.warehouses || []).filter(function(w) {
			return (!company || w.company === company) && !(exclude_sites && w.job);
		});
	}

	store_select(side, company, selected) {
		var list = this.stores(company, true);
		return [
			'<select class="nf-select" data-side="' + side + '">',
			selected ? '' : '<option value="">' + __('Choose a store') + '</option>',
			list.map(function(w) {
				return '<option value="' + nf_esc(w.name) + '"' + (w.name === selected ? ' selected' : '') + '>' + nf_esc(w.name) + '</option>';
			}).join('\n'),
			'</select>'
		].join('\n');
	}

	default_store(company, side) {
		var kept = nf_remembered(company + ':' + side);
		var ok = this.stores(company, true).some(function(w) { return w.name === kept; });
		return ok ? kept : ((this.ctx.main_stores || {})[company] || '');
	}

	// ---- home --------------------------------------------------------------

	home() {
		var ctx = this.ctx;
		var tiles = [];
		if (ctx.can_receive) tiles.push(this.tile('receive', 'tray-arrow-down', __('Receive'), __('Book a delivery in against a purchase order')));
		if (ctx.can_move) {
			tiles.push(this.tile('to-site', 'truck', __('Goods to site'), __('Send stock from the store to a job')));
			tiles.push(this.tile('used', 'wrench', __('Used on site'), __('Record what was fitted; it costs the job')));
		}
		tiles.push(this.tile('find', 'magnifying-glass', __('Find stock'), __('How much is there, and where')));

		this.render([
			'<div class="nf-hero">',
			'  <span class="nf-hero-mark">' + nf_icon('scan') + '</span>',
			'  <div>',
			'    <div class="nf-hero-title">' + __('Shop Floor') + '</div>',
			'    <div class="nf-hero-sub">' + __('Scan a job card, an order or an item') + '</div>',
			'  </div>',
			'</div>',
			this.scan_box(__('Scan or type a job, order or item')),
			'<div data-results></div>',
			'<div class="nf-menu">' + tiles.join('\n') + '</div>',
			'<div class="nf-links">',
			'  <button class="nf-link" data-go="labels">' + nf_icon('printer') + __('Print labels') + '</button>',
			ctx.job_board ? '  <button class="nf-link" data-go="board">' + nf_icon('kanban') + __('Job Board') + '</button>' : '',
			'</div>'
		].join('\n'));

		this.$root.find('[data-go]').on('click', (e) => {
			var go = $(e.currentTarget).attr('data-go');
			if (go === 'receive') this.receive_list();
			else if (go === 'to-site') this.pick_job(__('Goods to site'), (job) => this.move(job, 'to'));
			else if (go === 'used') this.pick_job(__('Used on site'), (job) => this.use(job));
			else if (go === 'find') this.find();
			else if (go === 'labels') this.pick_job(__('Print labels'), (job) => this.labels(job.name));
			else if (go === 'board') frappe.set_route('job-board');
		});
		this.bind_scan((term) => this.home_scan(term));
	}

	// Whatever was scanned on the home screen decides where to go.
	home_scan(term) {
		nf_call('resolve_scan', { term: term }).then((hit) => {
			if (hit.type === 'job') this.job(hit.value);
			else if (hit.type === 'purchase_order') this.receive_order(hit.value);
			else if (hit.type === 'item') this.find(hit.value);
			else this.suggest(hit, {
				item: (item) => this.find(item.item_code),
				job: (job) => this.job(job.name)
			});
		});
	}

	// Nothing matched exactly: say so, and offer close matches one tap away.
	suggest(hit, pick) {
		var items = (pick.item && hit.suggestions) || [];
		var jobs = (pick.job && hit.jobs) || [];
		var $results = this.$root.find('[data-results]');
		if (!items.length && !jobs.length) {
			$results.html('<div class="nf-note">' + nf_esc(hit.label) + '</div>');
			return;
		}
		var html = ['<div class="nf-note">' + nf_esc(hit.label) + ' ' + __('Did you mean:') + '</div>', '<div class="nf-list">'];
		jobs.forEach((j, i) => {
			html.push(this.row('data-sjob="' + i + '"', nf_icon('kanban') + ' ' + nf_esc(j.name), nf_esc(j.project_name), ''));
		});
		items.forEach((it, i) => {
			var right = it.actual_qty != null ? nf_qty(it.actual_qty) + ' ' + nf_esc(it.stock_uom || '') : '';
			html.push(this.row('data-sitem="' + i + '"', nf_esc(it.item_code), nf_esc(it.item_name), right));
		});
		html.push('</div>');
		$results.html(html.join('\n'));
		$results.find('[data-sjob]').on('click', function() { pick.job(jobs[+$(this).attr('data-sjob')]); });
		$results.find('[data-sitem]').on('click', function() { pick.item(items[+$(this).attr('data-sitem')]); });
	}

	// ---- a job -------------------------------------------------------------

	pick_job(title, next) {
		this.render([
			this.head(title, __('Which job?'), true),
			this.scan_box(__('Scan the job card, or type to find it')),
			'<div class="nf-list" data-jobs><div class="nf-note">' + __('Loading jobs...') + '</div></div>'
		].join('\n'));
		this.bind_back(() => this.home());

		var all = [];
		var paint = (filter) => {
			var f = (filter || '').toLowerCase();
			var shown = all.filter(function(j) {
				return !f || [j.name, j.project_name, j.customer, j.job_site].some(function(v) { return String(v || '').toLowerCase().indexOf(f) !== -1; });
			});
			var $list = this.$root.find('[data-jobs]');
			if (!shown.length) {
				$list.html('<div class="nf-note">' + (all.length ? __('No job matches that.') : __('No jobs on the go.')) + '</div>');
				return;
			}
			$list.html(shown.map((j, i) => {
				var sub = [j.project_name, j.customer].filter(Boolean).map(nf_esc).join(' · ');
				var right = j.job_stage ? '<span class="nf-tag">' + nf_esc(j.job_stage) + '</span>' : '';
				return this.row('data-job="' + nf_esc(j.name) + '"', nf_esc(j.name) + (j.job_site ? ' <span class="nf-dim">' + nf_icon('map-pin') + nf_esc(j.job_site) + '</span>' : ''), sub, right);
			}).join('\n'));
			$list.find('[data-job]').on('click', function() {
				var name = $(this).attr('data-job');
				next(all.filter(function(j) { return j.name === name; })[0]);
			});
		};

		nf_call('jobs').then((rows) => { all = rows || []; paint(''); });
		this.bind_scan((term) => {
			var exact = all.filter(function(j) { return j.name.toLowerCase() === term.toLowerCase(); })[0];
			if (exact) { next(exact); return; }
			nf_call('resolve_scan', { term: term }).then((hit) => {
				if (hit.type === 'job') next(hit.job);
				else this.say(hit.type === 'unknown' ? hit.label : __('That is {0}, not a job card.', [hit.label]));
			});
		}, paint);
	}

	job(name) {
		nf_call('job', { name: name }).then((job) => {
			var facts = [
				job.customer ? [__('Customer'), job.customer] : null,
				job.job_site ? [__('Site'), job.job_site] : null,
				job.job_stage ? [__('Stage'), job.job_stage] : null,
				job.job_warehouse ? [__('Site store'), job.job_warehouse] : null
			].filter(Boolean);
			var on_site = job.on_site || [];
			var ctx = this.ctx;
			this.render([
				this.head(job.name, job.project_name, true),
				'<div class="nf-card">',
				facts.map(function(f) { return '<div class="nf-fact"><span>' + nf_esc(f[0]) + '</span><b>' + nf_esc(f[1]) + '</b></div>'; }).join('\n'),
				'</div>',
				'<div class="nf-menu">',
				ctx.can_move ? this.tile('to-site', 'truck', __('Goods to site'), __('From the store to this job')) : '',
				ctx.can_move ? this.tile('used', 'wrench', __('Used on site'), __('What was fitted on this job')) : '',
				ctx.can_move && job.job_warehouse ? this.tile('back', 'arrow-u-down-left', __('Back to store'), __("What came back from site")) : '',
				'</div>',
				job.job_warehouse ? '<div class="nf-section">' + __('At site now') + '</div>' : '',
				job.job_warehouse ? (on_site.length ? '<div class="nf-list">' + on_site.map((b) => this.row('disabled', nf_esc(b.item_code), nf_esc(b.item_name), nf_qty(b.qty) + ' ' + nf_esc(b.stock_uom || ''))).join('\n') + '</div>' : '<div class="nf-note">' + __('Nothing at site yet.') + '</div>') : '',
				'<div class="nf-links">',
				'  <button class="nf-link" data-go="labels">' + nf_icon('printer') + __('Print labels') + '</button>',
				ctx.job_board ? '  <button class="nf-link" data-go="board">' + nf_icon('kanban') + __('Open on the Job Board') + '</button>' : '',
				'</div>'
			].join('\n'));
			this.bind_back(() => this.home());
			this.$root.find('[data-go]').on('click', (e) => {
				var go = $(e.currentTarget).attr('data-go');
				if (go === 'to-site') this.move(job, 'to');
				else if (go === 'used') this.use(job);
				else if (go === 'back') this.move(job, 'back');
				else if (go === 'labels') this.labels(job.name);
				else if (go === 'board') frappe.set_route('job-board', { job: job.name });
			});
		});
	}

	// ---- goods to site / back to store ---------------------------------------

	move(job, direction) {
		this.basket = [];
		var company = job.company;
		var site = job.job_warehouse;
		this.from = direction === 'back' && site ? site : this.default_store(company, 'from');
		this.to = direction === 'to' && site ? site : this.default_store(company, 'to');
		if (!site) this.to = '';
		this.paint_move(job, direction);
	}

	paint_move(job, direction) {
		var site = job.job_warehouse;
		var company = job.company;
		var title = direction === 'back' ? __('Back to store') : __('Goods to site');
		var from_html = direction === 'back' && site
			? '<div class="nf-fixed">' + nf_icon('map-pin') + nf_esc(site) + '</div>'
			: this.store_select('from', company, this.from);
		var to_html = direction === 'to' && site
			? '<div class="nf-fixed">' + nf_icon('map-pin') + nf_esc(site) + '</div>'
			: this.store_select('to', company, this.to);

		this.render([
			this.head(title, job.name + ' · ' + (job.project_name || ''), true),
			site ? [
				'<div class="nf-toggle" role="tablist">',
				'  <button data-dir="to" class="' + (direction === 'to' ? 'active' : '') + '">' + nf_icon('truck') + __('To site') + '</button>',
				'  <button data-dir="back" class="' + (direction === 'back' ? 'active' : '') + '">' + nf_icon('arrow-u-down-left') + __('Back to store') + '</button>',
				'</div>'
			].join('\n') : '',
			'<div class="nf-pair">',
			'  <label class="nf-label">' + __('From') + from_html + '</label>',
			'  <label class="nf-label">' + __('To') + to_html + '</label>',
			'</div>',
			this.scan_box(__('Scan or type an item')),
			'<div data-results></div>',
			'<div data-onsite></div>',
			'<div class="nf-section">' + __('To move') + '</div>',
			'<div class="nf-list" data-basket></div>',
			'<div class="nf-actions"><button class="nf-submit" data-record="1">' + nf_icon('check') + '<span data-record-label></span></button></div>'
		].join('\n'));

		this.bind_back(() => this.job(job.name));
		this.$root.find('[data-dir]').on('click', (e) => {
			var dir = $(e.currentTarget).attr('data-dir');
			if (dir !== direction) this.move(job, dir);
		});
		this.$root.find('[data-side]').on('change', (e) => {
			var side = $(e.currentTarget).attr('data-side');
			this[side] = $(e.currentTarget).val();
			nf_remember(company + ':' + side, this[side]);
			if (side === 'from') { this.basket = []; this.paint_basket(); }
		});
		// What is at site is the list to pick from when bringing goods back.
		if (direction === 'back' && site) this.paint_on_site(job, site);
		this.bind_scan((term) => this.basket_scan(term, this.from, __('{0} on hand in {1}')));
		this.$root.find('[data-record]').on('click', () => {
			if (!this.from || !this.to) { this.say(__('Choose where the goods come from and where they go.'), 'red'); return; }
			nf_call('move', {
				from_warehouse: this.from, to_warehouse: this.to, job: job.name,
				rows: JSON.stringify(this.basket.map(function(r) { return { item_code: r.item_code, qty: r.qty }; }))
			}, true).then((r) => {
				this.done(direction === 'back' ? __('Back in {0}', [this.to]) : __('Sent to {0}', [this.to]), r.name, [
					{ label: __('More for {0}', [job.name]), primary: true, fn: () => this.move(job, direction) },
					{ label: __('Back to the job'), fn: () => this.job(job.name) },
					{ label: __('Home'), fn: () => this.home() }
				]);
			});
		});
		this.paint_basket(__('Move {0}'));
	}

	// ---- used on site ------------------------------------------------------

	use(job) {
		this.basket = [];
		this.from = job.job_warehouse || this.default_store(job.company, 'from');
		var site = job.job_warehouse;
		this.render([
			this.head(__('Used on site'), job.name + ' · ' + (job.project_name || ''), true),
			'<div class="nf-pair">',
			'  <label class="nf-label">' + __('Used from') + (site ? '<div class="nf-fixed">' + nf_icon('map-pin') + nf_esc(site) + '</div>' : this.store_select('from', job.company, this.from)) + '</label>',
			'</div>',
			this.scan_box(__('Scan or type what was fitted')),
			'<div data-results></div>',
			'<div data-onsite></div>',
			'<div class="nf-section">' + __('Used') + '</div>',
			'<div class="nf-list" data-basket></div>',
			'<div class="nf-actions"><button class="nf-submit" data-record="1">' + nf_icon('check') + '<span data-record-label></span></button></div>'
		].join('\n'));

		this.bind_back(() => this.job(job.name));
		this.$root.find('[data-side]').on('change', (e) => {
			this.from = $(e.currentTarget).val();
			nf_remember(job.company + ':from', this.from);
			this.basket = [];
			this.paint_basket(__('Record {0} used'));
		});
		if (site) this.paint_on_site(job, site);
		this.bind_scan((term) => this.basket_scan(term, this.from, __('{0} at {1}')));
		this.$root.find('[data-record]').on('click', () => {
			nf_call('use', {
				job: job.name, warehouse: this.from,
				rows: JSON.stringify(this.basket.map(function(r) { return { item_code: r.item_code, qty: r.qty }; }))
			}, true).then((r) => {
				this.done(__('Used on {0}', [job.name]), r.name, [
					{ label: __('More for {0}', [job.name]), primary: true, fn: () => this.use(job) },
					{ label: __('Back to the job'), fn: () => this.job(job.name) },
					{ label: __('Home'), fn: () => this.home() }
				]);
			});
		});
		this.paint_basket(__('Record {0} used'));
	}

	// What is at the job's site store: tap a line to take from it.
	paint_on_site(job, site) {
		nf_call('job', { name: job.name }).then((fresh) => {
			var rows = fresh.on_site || [];
			var $box = this.$root.find('[data-onsite]');
			if (!rows.length) { $box.html('<div class="nf-note">' + __('Nothing at site yet.') + '</div>'); return; }
			$box.html('<div class="nf-section">' + __('At site now (tap to add)') + '</div><div class="nf-list">' +
				rows.map((b, i) => this.row('data-site="' + i + '"', nf_esc(b.item_code), nf_esc(b.item_name), nf_qty(b.qty) + ' ' + nf_esc(b.stock_uom || ''))).join('\n') +
				'</div>');
			$box.find('[data-site]').on('click', (e) => {
				var b = rows[+$(e.currentTarget).attr('data-site')];
				this.add_to_basket({ item_code: b.item_code, item_name: b.item_name, stock_uom: b.stock_uom, actual_qty: b.qty }, site, __('{0} at {1}'));
			});
		});
	}

	// A scan on a basket screen: an item goes to "how many", anything else is named and refused.
	basket_scan(term, warehouse, info_text) {
		if (!warehouse) { this.say(__('Choose the store first.'), 'red'); return; }
		nf_call('resolve_scan', { term: term, warehouse: warehouse }).then((hit) => {
			if (hit.type === 'item') this.add_to_basket(hit.item, warehouse, info_text);
			else if (hit.type === 'unknown') this.suggest(hit, { item: (item) => this.add_to_basket(item, warehouse, info_text) });
			else this.say(__('That is {0}. Scan an item.', [hit.label]));
		});
	}

	add_to_basket(item, warehouse, info_text) {
		this.$root.find('[data-results]').empty();
		var already = this.basket.filter(function(r) { return r.item_code === item.item_code; })[0];
		var have = flt(item.actual_qty) - (already ? already.qty : 0);
		if (have <= 0) {
			this.say(__('None of {0} left in {1}.', [item.item_code, warehouse]), 'red');
			return;
		}
		var uom = item.stock_uom || '';
		this.ask_qty(item, {
			default: Math.min(1, have) || have,
			max: have,
			max_text: __('Only {0} {1} in {2}.', [nf_qty(have), uom, warehouse]),
			info: nf_esc(info_text.replace('{0}', nf_qty(have) + ' ' + uom).replace('{1}', warehouse))
		}, (qty) => {
			if (already) already.qty += qty;
			else this.basket.push({ item_code: item.item_code, item_name: item.item_name, stock_uom: uom, qty: qty });
			this.paint_basket();
		});
	}

	paint_basket(label) {
		if (label) this.record_label = label;
		var $basket = this.$root.find('[data-basket]');
		if (!this.basket.length) {
			$basket.html('<div class="nf-note">' + __('Nothing added yet. Scan an item, or tap one above.') + '</div>');
		} else {
			$basket.html(this.basket.map(function(r, i) {
				return [
					'<div class="nf-row nf-row-static">',
					'  <span class="nf-row-main">' + nf_esc(r.item_code) + '</span>',
					'  <span class="nf-row-sub">' + nf_esc(r.item_name || '') + '</span>',
					'  <span class="nf-row-right nf-row-right-x">' + nf_qty(r.qty) + ' ' + nf_esc(r.stock_uom || '') + '</span>',
					'  <button class="nf-remove" data-remove="' + i + '" aria-label="' + __('Remove') + '">' + nf_icon('x') + '</button>',
					'</div>'
				].join('\n');
			}).join('\n'));
			$basket.find('[data-remove]').on('click', (e) => {
				this.basket.splice(+$(e.currentTarget).attr('data-remove'), 1);
				this.paint_basket();
			});
		}
		var n = this.basket.length;
		this.$root.find('[data-record]').prop('disabled', !n);
		this.$root.find('[data-record-label]').text(
			n ? (this.record_label || '{0}').replace('{0}', n === 1 ? __('1 item') : __('{0} items', [n])) : __('Add items first')
		);
	}

	// ---- receiving ---------------------------------------------------------

	receive_list() {
		this.render([
			this.head(__('Receive'), __('Which order is the delivery for?'), true),
			this.scan_box(__('Scan the order number, or type to find it')),
			'<div class="nf-list" data-orders><div class="nf-note">' + __('Loading orders...') + '</div></div>'
		].join('\n'));
		this.bind_back(() => this.home());

		var all = [];
		var paint = (filter) => {
			var f = (filter || '').toLowerCase();
			var shown = all.filter(function(o) {
				return !f || [o.name, o.supplier_name, o.project, o.project_name].some(function(v) { return String(v || '').toLowerCase().indexOf(f) !== -1; });
			});
			var $list = this.$root.find('[data-orders]');
			if (!shown.length) {
				$list.html('<div class="nf-note">' + (all.length ? __('No order matches that.') : __('Nothing is waiting to be received.')) + '</div>');
				return;
			}
			$list.html(shown.map((o) => {
				var sub = [o.supplier_name, o.project ? o.project + (o.project_name ? ' ' + o.project_name : '') : null].filter(Boolean).map(nf_esc).join(' · ');
				var right = o.schedule_date ? frappe.datetime.str_to_user(o.schedule_date) : '';
				return this.row('data-po="' + nf_esc(o.name) + '"', nf_esc(o.name), sub, right);
			}).join('\n'));
			$list.find('[data-po]').on('click', (e) => this.receive_order($(e.currentTarget).attr('data-po')));
		};

		nf_call('open_orders').then((rows) => { all = rows || []; paint(''); });
		this.bind_scan((term) => {
			var exact = all.filter(function(o) { return o.name.toLowerCase() === term.toLowerCase(); })[0];
			if (exact) { this.receive_order(exact.name); return; }
			nf_call('resolve_scan', { term: term }).then((hit) => {
				if (hit.type === 'purchase_order') this.receive_order(hit.value);
				else this.say(hit.type === 'unknown' ? hit.label : __('That is {0}, not a purchase order.', [hit.label]));
			});
		}, paint);
	}

	receive_order(name) {
		nf_call('order_lines', { purchase_order: name }).then((order) => {
			this.order = order;
			this.booked = {};
			var job = order.project ? order.project + (order.project_name ? ' · ' + order.project_name : '') : '';
			this.render([
				this.head(order.name, [order.supplier_name, job].filter(Boolean).join(' · '), true),
				this.scan_box(__('Scan an item off the delivery')),
				'<div data-results></div>',
				'<div class="nf-section">' + __('On this order (tap a line)') + '</div>',
				'<div class="nf-list" data-lines></div>',
				'<label class="nf-label">' + __("Supplier's delivery note (optional)"),
				'  <input class="nf-text" data-dn="1" autocomplete="off">',
				'</label>',
				'<div class="nf-actions"><button class="nf-submit" data-record="1">' + nf_icon('check') + '<span data-record-label></span></button></div>'
			].join('\n'));
			this.bind_back(() => this.receive_list());
			this.paint_lines();
			this.bind_scan((term) => this.receive_scan(term));
			this.$root.find('[data-record]').on('click', () => this.book_in());
		});
	}

	paint_lines() {
		var order = this.order;
		var booked = this.booked;
		var $lines = this.$root.find('[data-lines]');
		$lines.html(order.lines.map(function(l) {
			var mine = flt(booked[l.purchase_order_item]);
			var done = l.outstanding <= 0;
			var right = done
				? '<span class="nf-tag nf-tag-good">' + __('All in') + '</span>'
				: (mine ? '<span class="nf-tag nf-tag-good">' + __('Booking {0}', [nf_qty(mine)]) + '</span><br>' : '') +
				  '<span class="nf-dim">' + __('{0} to come', [nf_qty(l.outstanding) + ' ' + nf_esc(l.uom || '')]) + '</span>';
			return [
				'<button class="nf-row' + (mine ? ' nf-row-booked' : '') + (done ? ' nf-row-done' : '') + '" data-line="' + nf_esc(l.purchase_order_item) + '"' + (done ? ' disabled' : '') + '>',
				'  <span class="nf-row-main">' + nf_esc(l.item_code) + '</span>',
				'  <span class="nf-row-sub">' + nf_esc(l.item_name || '') + (l.warehouse ? ' · ' + nf_esc(l.warehouse) : '') + '</span>',
				'  <span class="nf-row-right">' + right + '</span>',
				'</button>'
			].join('\n');
		}).join('\n'));
		$lines.find('[data-line]').on('click', (e) => this.ask_line($(e.currentTarget).attr('data-line')));
		var n = Object.keys(booked).length;
		this.$root.find('[data-record]').prop('disabled', !n);
		this.$root.find('[data-record-label]').text(n ? (n === 1 ? __('Book in 1 line') : __('Book in {0} lines', [n])) : __('Book in'));
	}

	ask_line(po_item) {
		var line = this.order.lines.filter(function(l) { return l.purchase_order_item === po_item; })[0];
		if (!line || line.outstanding <= 0) return;
		var uom = line.uom || '';
		this.ask_qty(line, {
			label: __('How many arrived?'),
			default: flt(this.booked[po_item]) || line.outstanding,
			max: line.outstanding,
			max_text: __('Only {0} {1} still to come on this order.', [nf_qty(line.outstanding), uom]),
			info: nf_esc(__('{0} ordered, {1} still to come. Goes to {2}.', [nf_qty(line.ordered) + ' ' + uom, nf_qty(line.outstanding) + ' ' + uom, line.warehouse || ''])),
			action: __('Book')
		}, (qty) => {
			this.booked[po_item] = qty;
			this.paint_lines();
		});
	}

	// An item scanned off the delivery finds its line; the same item on two lines is asked about.
	receive_scan(term) {
		nf_call('resolve_scan', { term: term }).then((hit) => {
			if (hit.type !== 'item') {
				this.say(hit.type === 'unknown' ? hit.label : __('That is {0}. Scan an item off the delivery.', [hit.label]));
				return;
			}
			var open = this.order.lines.filter(function(l) { return l.item_code === hit.value && l.outstanding > 0; });
			if (!open.length) {
				var on_order = this.order.lines.some(function(l) { return l.item_code === hit.value; });
				this.say(on_order ? __('{0} is already all in on this order.', [hit.value]) : __('{0} is not on this order.', [hit.value]), 'red');
				return;
			}
			if (open.length === 1) { this.ask_line(open[0].purchase_order_item); return; }
			var d = new frappe.ui.Dialog({ title: __('{0} is on more than one line', [hit.value]), fields: [{ fieldtype: 'HTML', fieldname: 'lines' }] });
			d.fields_dict.lines.$wrapper.html('<div class="nf-root nf-in-dialog"><div class="nf-list">' + open.map((l) => {
				return this.row('data-pick="' + nf_esc(l.purchase_order_item) + '"', __('Line {0}', [l.idx]), nf_esc(l.warehouse || ''), __('{0} to come', [nf_qty(l.outstanding)]));
			}).join('\n') + '</div></div>');
			d.fields_dict.lines.$wrapper.find('[data-pick]').on('click', (e) => {
				d.hide();
				this.ask_line($(e.currentTarget).attr('data-pick'));
			});
			d.show();
		});
	}

	book_in() {
		var rows = Object.keys(this.booked).map((k) => ({ purchase_order_item: k, qty: this.booked[k] }));
		var order = this.order;
		nf_call('receive', {
			purchase_order: order.name,
			rows: JSON.stringify(rows),
			supplier_delivery_note: this.$root.find('[data-dn]').val() || ''
		}, true).then((r) => {
			var places = order.lines
				.filter((l) => this.booked[l.purchase_order_item])
				.map(function(l) { return l.warehouse; })
				.filter(function(w, i, a) { return w && a.indexOf(w) === i; });
			this.done(__('Booked in'), r.name + (places.length ? ' · ' + __('into {0}', [places.join(', ')]) : ''), [
				{ label: __('Another delivery'), primary: true, fn: () => this.receive_list() },
				order.project ? { label: __('Go to {0}', [order.project]), fn: () => this.job(order.project) } : null,
				{ label: __('Home'), fn: () => this.home() }
			].filter(Boolean));
		});
	}

	// ---- find stock --------------------------------------------------------

	find(item_code) {
		this.render([
			this.head(__('Find stock'), __('Scan or type an item'), true),
			this.scan_box(__('Scan or type an item')),
			'<div data-results></div>',
			'<div data-stock></div>'
		].join('\n'));
		this.bind_back(() => this.home());
		var show = (code) => {
			this.$root.find('[data-results]').empty();
			nf_call('stock_for', { item_code: code }).then((s) => this.paint_stock(s));
		};
		this.bind_scan((term) => {
			nf_call('resolve_scan', { term: term }).then((hit) => {
				if (hit.type === 'item') show(hit.value);
				else if (hit.type === 'unknown') this.suggest(hit, { item: (item) => show(item.item_code) });
				else this.say(__('That is {0}. Scan an item.', [hit.label]));
			});
		});
		if (item_code) show(item_code);
	}

	paint_stock(s) {
		var uom = s.stock_uom || '';
		var rows = s.rows || [];
		this.$root.find('[data-stock]').html([
			'<div class="nf-card">',
			'  <div class="nf-card-title">' + nf_esc(s.item_name || s.item_code) + '</div>',
			'  <div class="nf-dim">' + nf_esc(s.item_code) + '</div>',
			'  <div class="nf-totals">',
			'    <div><b>' + nf_qty(s.on_hand) + '</b><span>' + nf_esc(uom) + ' ' + __('on hand') + '</span></div>',
			'    <div><b>' + nf_qty(s.on_order) + '</b><span>' + nf_esc(uom) + ' ' + __('on order') + '</span></div>',
			'  </div>',
			'</div>',
			rows.length ? '<div class="nf-section">' + __('Where it is') + '</div><div class="nf-list">' + rows.map((r) => {
				var main = nf_esc(r.warehouse) + (r.job ? ' <span class="nf-tag">' + nf_esc(r.job) + '</span>' : '');
				var sub = r.ordered ? __('{0} on order', [nf_qty(r.ordered)]) : '';
				return this.row('disabled', main, sub, nf_qty(r.qty) + ' ' + nf_esc(uom));
			}).join('\n') + '</div>' : '<div class="nf-note">' + __('None in stock anywhere.') + '</div>'
		].join('\n'));
	}

	// ---- labels ------------------------------------------------------------

	labels(job_name) {
		nf_call('labels', { job: job_name }).then((data) => {
			var job = data.job;
			var label = function(cls, qr, big, small) {
				return '<div class="nf-label-card ' + cls + '"><div class="nf-qr">' + qr + '</div><div class="nf-label-text"><div class="nf-label-big">' + nf_esc(big) + '</div><div class="nf-label-small">' + nf_esc(small || '') + '</div></div></div>';
			};
			this.render([
				this.head(__('Labels for {0}', [job.name]), __('Print, stick on, scan with the phone'), true),
				'<div class="nf-actions nf-actions-top"><button class="nf-submit" data-print="1">' + nf_icon('printer') + __('Print') + '</button></div>',
				'<div class="nf-sheet">',
				'  <div class="nf-sheet-head">' + __('Job card') + '</div>',
				label('nf-label-job', job.qr, job.name, [job.project_name, job.customer, job.site].filter(Boolean).join(' · ')),
				data.orders.length ? '  <div class="nf-sheet-head">' + __('Purchase orders') + '</div>' : '',
				'  <div class="nf-label-grid">' + data.orders.map(function(o) { return label('', o.qr, o.name, o.supplier_name); }).join('\n') + '</div>',
				data.items.length ? '  <div class="nf-sheet-head">' + __('Items') + '</div>' : '',
				'  <div class="nf-label-grid">' + data.items.map(function(i) { return label('', i.qr, i.item_code, i.item_name); }).join('\n') + '</div>',
				'</div>'
			].join('\n'));
			this.bind_back(() => this.job(job.name));
			// Printed from a window of its own, so none of the desk comes along.
			this.$root.find('[data-print]').on('click', () => {
				var win = window.open('', '_blank');
				if (!win) { this.say(__('Allow pop-ups for this site to print the labels.'), 'red'); return; }
				win.document.write([
					'<!doctype html><html><head><meta charset="utf-8">',
					'<title>' + nf_esc(__('Labels for {0}', [job.name])) + '</title>',
					'<style>' + NF_PRINT_CSS + '</style></head><body>',
					this.$root.find('.nf-sheet').prop('outerHTML'),
					'<script>window.onload = function () { window.print(); };<\/script>',
					'</body></html>'
				].join('\n'));
				win.document.close();
			});
		});
	}
}
