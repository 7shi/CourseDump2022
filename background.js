chrome.action.onClicked.addListener((tab) => {
	chrome.scripting.executeScript({
		target: { tabId: tab.id },
		files: ['coursedump2022.js']
	});
});

function sleep(ms) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

const apiTimeout = 5000;

function download(options) {
	return new Promise(async (resolve, reject) => {
		let id, deltas = {};
		const onDownloadComplete = delta => {
			if (id === undefined) {
				deltas[delta.id] = delta;
			} else if (delta.id == id) {
				checkDelta(delta);
			}
		}
		chrome.downloads.onChanged.addListener(onDownloadComplete);
		function checkDelta(delta) {
			if (delta.state && delta.state.current === "complete") {
				chrome.downloads.onChanged.removeListener(onDownloadComplete);
				resolve(delta.id);
			} else if (delta.error) {
				chrome.downloads.onChanged.removeListener(onDownloadComplete);
				reject(new Error(delta.error.current));
			} else if (delta.state && delta.state.current === "interrupted") {
				chrome.downloads.onChanged.removeListener(onDownloadComplete);
				reject(new Error(delta.state.current));
			}
		}
		const timeId = setTimeout(async () => {
			if (id !== undefined) return;
			if (options.url) {
				const query = { url: options.url };
				const items = await chrome.downloads.search(query);
				if (items.length) {
					id = items[0].id;
					if (id in deltas) checkDelta(deltas[id]);
					return;
				}
			}
			reject(new Error("API timeout"));
		}, apiTimeout);
		try {
			id = await chrome.downloads.download(options);
		} catch (e) {
			return reject(e);
		} finally {
			clearTimeout(timeId);
		}
		if (id in deltas) checkDelta(deltas[id]);
	});
}

let stopFlag = false;

function stopAll() {
	stopFlag = true;
}

let maxConnections = 15;
let queue = [];

async function downloadFiles() {
	console.log("start dumping", queue.length, "files...");
	const header = "data:text/plain;charset=utf-8,";
	let url = header, no = 0, i = 0;
	async function dwl() {
		const filename = `files${(++no).toString().padStart(3, "0")}.txt`;
		console.log("dumping:", filename, `(${i}/${queue.length})`);
		try {
			const id = await download({ url, filename });
			await chrome.downloads.erase({ id });
		} catch (e) {
			console.error(e);
		}
		url = header;
	}
	const maxlen = 100 * 1024 * 1024;
	for (; i < queue.length; i++) {
		const [u, f] = queue[i];
		url += encodeURIComponent(u + "\t" + f + "\n");
		if (url.length > maxlen) await dwl();
	}
	if (url.length > header.length) await dwl();
	console.log("dumping done.");
}

let total = 0;
let done = 0;

chrome.runtime.onMessage.addListener(async (arg, sender, sendResponse) => {
	if (arg.type == "coursedump_stop") {
		stopAll();
	} else if (arg.type == "coursedump_clear") {
		queue = [];
		total = done = 0;
	} else if (arg.type === "coursedump_add") {
		queue.push(...arg.collection);
		total += arg.collection.length;
	} else if (arg.type === "coursedump_dump") {
		await downloadFiles();
	} else if (arg.type === "coursedump_download") {
		stopFlag = false;
		if (arg.collection) {
			queue = arg.collection;
			total = queue.length;
			done = 0;
		}
		if (arg.max) maxConnections = arg.max;
		if (arg.dump) await downloadFiles();
		const pids = Array(Math.min(total, maxConnections)).fill().map((_, i) => i + 1);
		console.log("starting", pids.length, "promise(s)...");
		const results = await Promise.allSettled(pids.map(async pid => {
			while (!stopFlag && queue.length) {
				const [url, filename] = queue.shift();
				await sleep(200);
				try {
					const id = await download({ url, filename, conflictAction: "overwrite" });
					await chrome.downloads.erase({ id });
				} catch (e) {
					// console.error(filename, e);
					chrome.tabs.sendMessage(sender.tab.id, {
						type: "coursedump_error",
						error: e.message,
						url, filename
					});
				}
				done++;
				chrome.tabs.sendMessage(sender.tab.id, {
					type: "coursedump_progress_upd",
					progress: "" + Math.floor(10000 * done / total) / 100 + "%",
					done, total
				});
			}
			console.log(`pid ${pid}: fulfilled`);
		}));
		for (let i = 0; i < results.length; i++) {
			const r = results[i];
			if (r.status === "rejected") {
				console.error(`pid ${i + 1}: ${r.reason}`);
			}
		}
		chrome.tabs.sendMessage(sender.tab.id, {
			type: "coursedump_progress_upd",
			progress: stopFlag ? "stopped" : "done",
			done, total
		});
	}
});
