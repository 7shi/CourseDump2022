var initialized, stopping, download_queue, downloadMode;
var progressbar, dwldprogress;
var errors, downloading;
var courseRange = []; // [[start, end], ...]

var maxConnections = 10;
var modifyMode = false;
var noDownload = false;
var fixURL = false;

var ALWAYS_DWLD_MEDIA, ANKI_HELP_PROMPT, BATCH, LEVEL_TAGS, EXTRA_INFO, COLLAPSE_COLUMNS;
var MAX_ERR_ABORT, MIN_FILENAME_LENGTH, MAX_EXTRA_FIELDS, LEARNABLE_IDS, FAKE_DWLD, PLAIN_DWLD;

async function initialize() {
	await readSettings();
	if (!chrome.runtime.onMessage.hasListener(messageListener)) {
		chrome.runtime.onMessage.addListener(messageListener);
	}

	initialized = true;
	stopping = false;
	downloading = false;
	downloadMode = false;
	download_queue = [];

	// progressbar = document.getElementById('dumpprogress');
	progressbar = document.createElement("div");
	progressbar.id = "dumpprogress";
	progresspadding = document.createElement("div");
	progresspadding.id = "progresspadding";
	try {
		document.querySelector(".rebrand-header-root").prepend(progressbar);
		document.querySelector("#page-head").prepend(progresspadding);
	} catch (err) {
		document.body.prepend(progressbar);
	}
	// document.getElementById('header').prepend(progressbar);
	dwldprogress = document.createElement("div");
	dwldprogress.id = "downprogress";
	dwldprogress.style.background = "transparent";
	dwldprogress.style.color = "white";
	dwldprogress.style.whiteSpace = "nowrap"
	progressbar.append(dwldprogress);
}

async function readSettings() {
	//fallback settings
	ALWAYS_DWLD_MEDIA = false;
	ANKI_HELP_PROMPT = true;
	BATCH = false;
	LEVEL_TAGS = true;
	EXTRA_INFO = false;
	COLLAPSE_COLUMNS = true;

	MAX_ERR_ABORT = 5;
	MIN_FILENAME_LENGTH = 8;
	MAX_EXTRA_FIELDS = 5;
	LEARNABLE_IDS = false;
	FAKE_DWLD = false;
	PLAIN_DWLD = false;

	//overwrite settings with settings from json file
	try {
		const response = await fetch(chrome.runtime.getURL('settings.json'))
		const settings = await response.json();
		try {
			ALWAYS_DWLD_MEDIA = settings.user_settings.always_download_media;
			ANKI_HELP_PROMPT = settings.user_settings.display_anki_help_prompt;
			BATCH = settings.user_settings.batch_download;
			LEVEL_TAGS = settings.user_settings.level_tags;
			EXTRA_INFO = settings.user_settings.extra_info;
			COLLAPSE_COLUMNS = true;//settings.user_settings.collapse_columns;

			LEARNABLE_IDS = settings.extra_settings.learnable_ids;
			PLAIN_DWLD = settings.extra_settings.exclude_course_metadata;
			FAKE_DWLD = settings.extra_settings.skip_media_download;

			MAX_ERR_ABORT = settings.basic_settings.max_level_skip;
			MIN_FILENAME_LENGTH = settings.basic_settings.min_filename_length;
			MAX_EXTRA_FIELDS = settings.basic_settings.max_extra_fields;

			//console.log(MIN_FILENAME_LENGTH);
		} catch (err) {
			console.log('overwriting settings error')
		};
	} catch (error) {
		console.error('Error reading settings.json:', error);
	}
}


async function readAllLines(file) {
	try {
		const response = await fetch(chrome.runtime.getURL(file));
		const text = await response.text();
		return text.length ? text.replaceAll("\r\n", "\n").split("\n") : [];
	} catch {
		return [];
	}
}

function sleep(ms) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchRetry(url, options, retries = 3, interval = 1000) {
	let ret;
	for (let i = 0; i < retries; i++) {
		if (i) console.log("retry", i);
		await sleep(i ? interval : 200);
		try {
			ret = await fetch(url, options);
			if (ret.status != 502) break;
		} catch (e) {
			if (i == retries - 1) throw e;
		}
	}
	return ret;
}


async function CourseDownload(URLString, prefix = "") {
	let course = URLString.split("/");
	let id, name, caption, scanprogress;

	if (course[4] === "course") { 
		id = course[5]; 
		name = course[6];
		caption = `${prefix}${id}/${name}`;

		scanprogress = document.createElement("div");
		scanprogress.className = "scanprogress cid" + id;
			scanprogress.style.width = 0;
			scanprogress.style.background = "darkcyan";
			scanprogress.style.color = "white";
			scanprogress.style.whiteSpace = "nowrap";
			scanprogress.innerText = caption;
		progressbar.append(scanprogress);
		
	} else { 
		if (!BATCH) {
			alert("Please use the extention on an open Memrise course tab"); 
		} else {
			console.log('"' + URLString + '" in queue.txt is not a Memrise course URL');
		}
		return -1; 
	};

	function PaddedFilename(url) {
		let temp_filename = url.split("/").slice(-1);
		if (temp_filename[0].length < MIN_FILENAME_LENGTH) {
			let pad = url.split("/").slice(-2)[0];
			if (pad === 'medium') {pad = url.split("/").slice(-3)[0].replaceAll('%','_')};
			temp_filename = name + "_" + pad + "_" + url.split("/").slice(-1).join("_");
		};
		return temp_filename;
	}


//------------------------------------------Fetching course metadata
	let description = '';
	let author = '';
	let ava = 'https://static.memrise.com/accounts/img/placeholders/empty-avatar-2.png'; // -> rnd 1..4
	let propName = '';
	let courseImg = '';
	let levelsN = 0;
	let courseHtml = 'data:text/html;charset=utf-8,';
	try {
	let meta = fetchRetry('https://app.memrise.com/community/course/' + id )
	    .then(response => response.text())
	    .then(html => {
	        courseHtml += encodeURIComponent(html);
	        var parser = new DOMParser();
	        var doc = parser.parseFromString(html, "text/html");
		levelsN     = (query => (query ? query.childElementCount : 1))(doc.querySelector('div.levels'));
		author      = doc.querySelector('.creator-name span').innerText;
		ava         = doc.querySelector('.creator-image img').src;
		propName    = doc.querySelector('.course-name').innerText;
		courseImg   = doc.querySelector('.course-photo img').src;
		const desc = doc.querySelector('.course-description.text');
		if (desc) description = desc.innerText;
	    })
	    .catch(function(err) {  
	        console.log('Failed to fetch html: ', err);  
	});
	await meta;
	
	} catch (err) {}
	console.log("course: ", propName);
	// console.log("about: ", description);
	// console.log("by: ", author);
	// console.log("ava ", ava);
	// console.log("icon ", courseImg);
	// console.log("number of levels: ", levelsN);
	
	//choosing names and queueing meta
	let saveas, subfolder;
	if (PLAIN_DWLD) {
		saveas = name + ` by ` + author + ` [` + id +`]`; //general name for csv and media folder 
		subfolder = ``;
	} else {
		saveas = name + ` [` + id +`]`; //general name for csv and media folder
		subfolder = `${name}_${id}/`;

		//(info moved below)
		if (!modifyMode) {
			download_queue.push([courseHtml, `${subfolder}0.html`]);
			download_queue.push([ava, subfolder + 'creator.' + ava.split(".").slice(-1)]);
			const imgpath = courseImg.split("/");
			const imgdiv  = imgpath[imgpath.length - 1].split(".");
			const imgext  = imgdiv.length > 1 ? imgdiv[imgdiv.length - 1] : "jpg";
			download_queue.push([courseImg, subfolder + 'course.' + imgext]);
		}
	}


//------------------------------------------Fetching level data	
	let err_count = 0;
	let media_asked = false;
	let download_media = false;
	let has_audio = false;
	let has_video = false;
	let attributes = [];
	let visible_info = [];
	let hidden_info = [];
	let has_definitions = false;
	let has_learnable = false;
	let media_download_urls = new Set();
	let media_added = new Set();
	let table = [];

	if (ALWAYS_DWLD_MEDIA) {
		media_asked = true;
		download_media = true;
	}

	function addQueue() {
		if (FAKE_DWLD) return;
		const diff = [...media_download_urls].filter(x => !media_added.has(x));
		for (const url of diff) {
			download_queue.push([url, `${subfolder}media/` + PaddedFilename(url)]);
			media_added.add(url);
		}
		dwldprogress.innerText = `${download_queue.length}`;
	}


	let next = true;
	for (let i = 1; next || i <= levelsN; i++) {
		if (stopping) return;
		//marking scanprogress
		addQueue();
		// console.log(`[${name}] ${i}/${levelsN}`);
		const prog = Math.min(100, Math.round(10000. * i / (levelsN + MAX_ERR_ABORT/2))/100) + "%";
		scanprogress.style.width = prog;
		scanprogress.innerText = `${caption} | ${i}/${levelsN} (${prog}) ${media_added.size} media`;
		
		let empty_set_err = false;
		try {
			// get CSRF header
			token = document.cookie.split(" ").find(cookie => cookie.includes("csrftoken")).split(/[=;]/g)[1];
			const options = {
				"headers": { "Accept": "*/*", "Content-Type": "Application/json", "X-CSRFToken": token },
				"body": "{\"session_source_id\":" + id + ",\"session_source_type\":\"course_id_and_level_index\",\"session_source_sub_index\":" + i + "}",
				"method": "POST"
			};
			let resp = await fetchRetry("https://app.memrise.com/v1.19/learning_sessions/preview/", options);
			response = await resp.json();
			if (!response.learnables) console.log(response);
			// Continue after empty set
			if (response.code == "PREVIEW_DOESNT_LOAD") {
				empty_set_err = true;
			}
			if (empty_set_err || response.code == "MULTIMEDIA_LEVEL_UNSUPPORTED") {
				let url = URLString.trim();
				if (!url.endsWith("/")) url += "/";
				url += `${i}/`;
				download_queue.push([url, `${subfolder}${i}.html`]);
			}
			if (modifyMode) {
				if (!response.learnables) throw new Error("no learnables");
				continue;
			}
			// Check for media
			if (!media_asked && !BATCH && 
				response.learnables.find(learnable => { return ( 
					(learnable.screens["1"].audio && learnable.screens["1"].audio.value.length > 0) || 
					(learnable.screens["1"].video && learnable.screens["1"].video.value.length > 0) || 
					(learnable.screens["1"].definition.kind === "audio" && learnable.screens["1"].definition.value.length > 0) ||
					(learnable.screens["1"].definition.kind === "image" && learnable.screens["1"].definition.value.length > 0) ||
					(learnable.screens["1"].item.kind === "image" && learnable.screens["1"].item.value.length > 0) 
				)}	)) {
				media_asked = true;
				download_media = confirm("Embedded media was detected. Would you like to download it?");
			}
			if (BATCH) {download_media = ALWAYS_DWLD_MEDIA};

			let level_tag = `"` + name + `"`;
			if (LEVEL_TAGS) {
				try {
					level_tag = `"` + response.session_source_info.name.replaceAll('"', '""') + `::` + ((levelsN && levelsN > 99 && i < 100) ? (`0`) : ``) + ((i < 10) ? (`0` + i) : i) + `_` + response.session_source_info.level_name.replaceAll('"', '""') + `"`;
				} catch (error) {console.log(`${error.name}: ${error.message}`);}
				level_tag = level_tag.replaceAll(' ','_');
			}


			// Creating the table and queueing media files
			response.learnables.map(learnable => {

				let row = [];

				//learning elements
				let learnable_el = `""`;
				if (learnable.learning_element) {
					has_learnable = true;
					learnable_el = `"${learnable.learning_element.replaceAll('"', '""')}"`;
				} else if (download_media && learnable.screens["1"].item.kind === "audio" && learnable.screens["1"].item.value.length > 0) {
					has_learnable = true;
					let temp_audio_learns = [];
					learnable.screens["1"].item.value.map(audio_learn => {temp_audio_learns.push(audio_learn.normal)});
					temp_audio_learns.forEach(media_download_urls.add, media_download_urls);
					learnable_el = `"` + temp_audio_learns.map(url => `[sound:${PaddedFilename(url)}]`).join("") + `"`;
				} else if (download_media && learnable.screens["1"].item.kind === "image" && learnable.screens["1"].item.value.length > 0) { 
					has_learnable = true;
					let temp_image_learns = [];
					learnable.screens["1"].item.value.map(image_learn => {temp_image_learns.push(image_learn)});
					temp_image_learns.forEach(media_download_urls.add, media_download_urls);
					learnable_el = `"` + temp_image_learns.map(url => `<img src='${PaddedFilename(url)}'>`).join(``) + `"`;
				}
				row.push(learnable_el);

				//definitions
				let definition = `""`;
				if (learnable.definition_element) {
					has_definitions = true;
					definition = `"${learnable.definition_element.replaceAll('"', '""')}"`;
				} else if (download_media && learnable.screens["1"].definition.kind === "audio" && learnable.screens["1"].definition.value.length > 0) {
					has_definitions = true;
					let temp_audio_defs = [];
					learnable.screens["1"].definition.value.map(audio_def => {temp_audio_defs.push(audio_def.normal)});
					temp_audio_defs.forEach(media_download_urls.add, media_download_urls);
					definition = `"` + temp_audio_defs.map(url => `[sound:${PaddedFilename(url)}]`).join("") + `"`;
				} else if (download_media && learnable.screens["1"].definition.kind === "image" && learnable.screens["1"].definition.value.length > 0) {
					has_definitions = true;
					let temp_image_defs = [];
					learnable.screens["1"].definition.value.map(image_def => {temp_image_defs.push(image_def)});
					temp_image_defs.forEach(media_download_urls.add, media_download_urls);
					definition = `"` + temp_image_defs.map(url => `<img src='${PaddedFilename(url)}'>`).join(``) + `"`;
				}
				row.push(definition);


				//audio
				let temp_audio_urls = [];
				if (download_media && learnable.screens["1"].audio && learnable.screens["1"].audio.value.length > 0) {
					has_audio = true;
					learnable.screens["1"].audio.value.map(audio_item => {temp_audio_urls.push(audio_item.normal)});
					temp_audio_urls.forEach(media_download_urls.add, media_download_urls);
				}
				row.push(`"` + temp_audio_urls.map(url => `[sound:${PaddedFilename(url)}]`).join("") + `"`);

				//video
				let temp_video_urls = [];
				if (download_media && learnable.screens["1"].video && learnable.screens["1"].video.value.length > 0) {
					has_video = true;
					learnable.screens["1"].video.value.map(video_item => {temp_video_urls.push(video_item)});
					temp_video_urls.forEach(media_download_urls.add, media_download_urls);
				}
				row.push(`"` + temp_video_urls.map(url => `[sound:${PaddedFilename(url)}]`).join("") + `"`);
							
				//extra data
				//	attr[0]: 686844 - SS; 1995282 - PoS;
				let temp_extra1 = new Array(MAX_EXTRA_FIELDS).fill(``);
				if (EXTRA_INFO && learnable.screens["1"].attributes && learnable.screens["1"].attributes.length > 0) {
					learnable.screens["1"].attributes.forEach(attribute => {
						if (attribute && attribute.value && attribute.label) {
							let ind = attributes.indexOf(attribute.label);
							if (ind == -1 && attributes.length < MAX_EXTRA_FIELDS) {
								attributes.push(attribute.label);
							}
							ind = attributes.indexOf(attribute.label);
							if (ind != -1) {
								temp_extra1[ind] = attribute.value;
							}
						}
					})
				}
				temp_extra1.forEach(el => row.push(`"` + el + `"`));

				//	visible_info[0]: 548340 - kana; 6197256 - syn; 2021373+2021381 - lit trans/pinyin;
				//	visible_info[1]: 2021373+2021381 - pinyin;
				let temp_extra2 = new Array(MAX_EXTRA_FIELDS).fill(``);
				if (EXTRA_INFO && learnable.screens["1"].visible_info && learnable.screens["1"].visible_info.length > 0) {
					learnable.screens["1"].visible_info.forEach(v_info => {
						if (v_info && v_info.value && v_info.label) {
							let ind = visible_info.indexOf(v_info.label);
							if (ind == -1 && visible_info.length < MAX_EXTRA_FIELDS) {
								visible_info.push(v_info.label);
							}
							ind = visible_info.indexOf(v_info.label);
							if (ind != -1) {
								if (download_media && v_info.kind === "audio" && v_info.value.length > 0) {
									let temp_audio_list = [];
									v_info.value.map(audio => {temp_audio_list.push(audio.normal)});
									temp_audio_list.forEach(media_download_urls.add, media_download_urls);
									temp_extra2[ind] = `` + temp_audio_list.map(url => `[sound:${PaddedFilename(url)}]`).join("") + ``;
								} else if (download_media && v_info.kind === "image" && v_info.value.length > 0) {
									let temp_image_list = [];
									v_info.value.map(image => {temp_image_list.push(image)});
									temp_image_list.forEach(media_download_urls.add, media_download_urls);
									temp_extra2[ind] = `` + temp_image_list.map(url => `<img src='${PaddedFilename(url)}'>`).join(``) + ``;
								} else if (v_info.kind !== "audio" && v_info.kind !== "image") {
									temp_extra2[ind] = v_info.value;
								}
							}
						}
					})
				}
				temp_extra2.forEach(el => row.push(`"` + el + `"`));

				//	hidden_info[0]: 1995282 - inflections;
				let temp_extra3 = new Array(MAX_EXTRA_FIELDS).fill(``);
				if (EXTRA_INFO && learnable.screens["1"].hidden_info && learnable.screens["1"].hidden_info.length > 0) {
					learnable.screens["1"].hidden_info.forEach(h_info => {
						if (h_info && h_info.value && h_info.label) {
							let ind = hidden_info.indexOf(h_info.label);
							if (ind == -1 && hidden_info.length < MAX_EXTRA_FIELDS) {
								hidden_info.push(h_info.label);
							}
							ind = hidden_info.indexOf(h_info.label);
							if (ind != -1) {
								if (download_media && h_info.kind === "audio" && h_info.value.length > 0) {
									let temp_audio_list = [];
									h_info.value.map(audio => {temp_audio_list.push(audio.normal)});
									temp_audio_list.forEach(media_download_urls.add, media_download_urls);
									temp_extra3[ind] = `` + temp_audio_list.map(url => `[sound:${PaddedFilename(url)}]`).join("") + ``;
								} else if (download_media && h_info.kind === "image" && h_info.value.length > 0) {
									let temp_image_list = [];
									h_info.value.map(image => {temp_image_list.push(image)});
									temp_image_list.forEach(media_download_urls.add, media_download_urls);
									temp_extra3[ind] = `` + temp_image_list.map(url => `<img src='${PaddedFilename(url)}'>`).join(``) + ``;
								} else if (h_info.kind !== "audio" && h_info.kind !== "image") {
									temp_extra3[ind] = h_info.value;
								}
							}
						}
					})
				}
				temp_extra3.forEach(el => row.push(`"` + el + `"`));

				//tags
				row.push(level_tag);

				if (LEARNABLE_IDS) {
					try {
						row.push(learnable.id);
					} catch (error) {
						console.log(`no learnable id! ${error.name}: ${error.message}`);
						row.push(-1);
					}
				}
				table.push(row);

			});

			err_count = 0;
		} catch (error) {
			console.log(error);
			console.log('Level does not exist or has no learnable words. Level skip count: ' + (err_count + 1));
			if (empty_set_err) continue;
			err_count++;
			if (err_count >= MAX_ERR_ABORT) {
				next = false;
			}
		}
	}
	if (modifyMode) return;


	//global flags (e.g. has_audio, has_video..) are needed to keep consistency of column content between all table rows
	let course_fields = [];
	if (has_learnable) {course_fields.push("Learnable")};
	if (has_definitions) {course_fields.push("Definition")};
	if (has_audio) {course_fields.push("Audio")};
	if (has_video) {course_fields.push("Video")};
	course_fields.push(...attributes);
	course_fields.push(...visible_info);
	course_fields.push(...hidden_info);
	if (LEVEL_TAGS) {course_fields.push("Level tags")};
	if (LEARNABLE_IDS) {course_fields.push("Learnable ID")};

	//downloading info
	let info;
	info = 'data:md/plain;charset=utf-8,' + encodeURIComponent( 
		`# **` + propName + `**\n` + 
		`### by _` + author + `_\n` +
		`\n` + 
		description + 
		`\n\n` + 
		`## Course Fields\n` +
		`| ` + course_fields.join(` | `) + ` |`
	);
	if (!PLAIN_DWLD) {
		download_queue.push([info, subfolder + 'info.md']);
	}

	//console.log(table[0]);

	//table to text conversion
	let result = table.map(row => {
		if (COLLAPSE_COLUMNS) {
			let line = [];
			if (has_learnable) {line.push(row[0])};
			if (has_definitions) {line.push(row[1])};
			if (has_audio) {line.push(row[2])};
			if (has_video) {line.push(row[3])};

			line.push(...row.slice(4						, 4 + attributes.length));
			line.push(...row.slice(4 + MAX_EXTRA_FIELDS		, 4 + MAX_EXTRA_FIELDS + visible_info.length));
			line.push(...row.slice(4 + 2* MAX_EXTRA_FIELDS	, 4 + 2* MAX_EXTRA_FIELDS + hidden_info.length));

			if (LEVEL_TAGS) {line.push(row[4 + 3 * MAX_EXTRA_FIELDS])};
			if (LEARNABLE_IDS) {line.push(row[4 + 3 * MAX_EXTRA_FIELDS + 1])};
			return line.join(`,`);
		} else {return row.join(`,`);}
	}).join("\n") + "\n";

	//downloading the table
	let csvdata = 'data:text/csv;charset=utf-8,%EF%BB%BF' + encodeURIComponent(result);
	if (PLAIN_DWLD) {
		var downloadElement = document.createElement('a');
		downloadElement.target = '_blank';
		downloadElement.href = csvdata;
		downloadElement.download = saveas + '.csv';
		downloadElement.click();
	} else {
		download_queue.push([csvdata, subfolder + 'table.csv']);
	}

	//appending files to media download queue
	if (download_media) {console.log("[" + name + "] media files found: " + media_download_urls.size)};	
	addQueue();
};

async function mediaDownload(all_downloads) {
	if (stopping) return;
	console.log("preparing download queue...");
	const fileUrl = {};
	const down_d = [];
	const down_u = [];
	errors = 0;
	for (let [url, filename] of all_downloads) {
		let p;
		if (fixURL && url.startsWith("http")) {
			p = url.lastIndexOf("/") + 1;
			if (p <= 0) {
				console.error("invalid URL:", url);
				continue;
			}
			url = encodeURI(url.slice(0, p)) + encodeURIComponent(url.slice(p));
		}
		p = filename.lastIndexOf("/");
		if (p < 0) {
			console.error("invalid filename:", filename);
			continue;
		}
		const dn = filename.slice(0, p);
		let bn = filename.slice(p + 1);
		if (bn.startsWith(".")) {
			bn = "_" + bn.slice(1);
			filename = dn + "/" + bn;
		}
		p = bn.indexOf("?");
		if (p > 0) {
			bn = bn.slice(0, p);
			filename = dn + "/" + bn;
		}
		const bnd = decodeURI(bn).replaceAll("%", "_").normalize("NFC")
		if (bn != bnd) {
			bn = bnd;
			filename = dn + "/" + bn;
		}
		if (filename in fileUrl) {
			console.error("duplicate:", filename);
			const url2 = fileUrl[filename];
			if (url2 != url) {
				console.error("- URL mismatch:", url2);
			}
		} else {
			fileUrl[filename] = url;
			if (url.startsWith("data:")) {
				down_d.push([url, filename]);
			} else if (url.startsWith("http")) {
				down_u.push([url, filename]);
			} else {
				console.error("invalid URL:", url);
			}
		}
	}

	dwldprogress.style.width = 0;
	dwldprogress.style.background = "darkred";

	console.log("Data:", down_d.length);
	console.log("URL:", down_u.length);

	const downloads = down_d.concat(down_u);
	console.log("sending download queue:", downloads.length);
	chrome.runtime.sendMessage({
		type: "coursedump_clear"
	});
	let len = 0, start = 0;
	const maxlen = 512 * 1024;
	for (let i = 0; i <= downloads.length; i++) {
		const final = i == downloads.length;
		if (len > maxlen || final) {
			const prog = Math.floor(10000 * i / downloads.length) / 100;
			dwldprogress.innerText = `${i}/${downloads.length} (${prog}%)`;
			dwldprogress.style.width = `${prog}%`;
			await chrome.runtime.sendMessage({
				type: "coursedump_add",
				collection: downloads.slice(start, i)
			});
			start = i;
			len = 0;
		}
		if (!final) {
			const dl = downloads[i];
			len += dl[0].length + dl[1].length;
		}
	}

	dwldprogress.style.width = 0;
	dwldprogress.style.background = "darkorange";

	downloading = true;
	if (noDownload) {
		console.log("dumping files...");
		await chrome.runtime.sendMessage({
			type: "coursedump_dump"
		});
		console.log("done.");
		console.log("Stop. Please resume if you want to download.");
		stopping = true;
		return;
	}
	console.log("start downloading...");
	chrome.runtime.sendMessage({
		type: "coursedump_download",
		max: downloadMode ? 1 : maxConnections + 5,
		dump: !downloadMode
	});
}


//------MAIN

function stopOrResume() {
	if (!stopping) {
		console.log("STOP");
		stopping = true;
		chrome.runtime.sendMessage({
			type: "coursedump_stop"
		});
	} else if (downloading) {
		console.log("RESUME");
		stopping = false;
		chrome.runtime.sendMessage({
			type: "coursedump_download"
		});
	} else {
		console.log("Can not RESUME.");
	}
}

function messageListener(arg, sender, sendResponse) {
	var type = arg.type;
	var prog = arg.progress;
	if (type === "coursedump_progress_upd") {
		if (prog === "done") {
			progressbar.className = "done";
			const divs = Array.from(progressbar.getElementsByTagName('div'));
			for (const div of divs) {
				progressbar.removeChild(div);
			}
			console.log("[", arg.done, "/", arg.total, "] errors:", errors);

			//help
			setTimeout(() => {
				if (ANKI_HELP_PROMPT && !BATCH && confirm('Would you like some help with importing the downloaded data into Anki?')) {
					window.open('https://github.com/Eltaurus-Lt/CourseDump2022#importing-into-anki', '_blank').focus();
				}
			}, 200);

		} else if (prog == "stopped") {
			console.log("stopped");
		} else {
			const t = `${arg.done}/${arg.total} (${prog})`;
			// console.log(t, "media queued");
			dwldprogress.innerText = t;
			dwldprogress.style.width = prog;
		}
	} else if (type == "coursedump_error") {
		errors++;
		console.error(arg.error, arg.url, arg.filename);
	}
}

(async function () {
	if (initialized) return stopOrResume();
	await initialize();

	let currentUrl = window.location.toString();
	if (currentUrl.split("/")[2] !== 'app.memrise.com') {
		alert("The extension should be used on the memrise.com site");
		return -1;
	}
	try {
		let missing;
		if (courseRange.length) {
			missing = [];
			for (const [start, end] of courseRange) {
				for (let i = start; i <= end; i++) {
					missing.push(`https://app.memrise.com/community/course/${i}/\tcourse/${i}.html`);
				}
			}
		} else {
			missing = await readAllLines("missing.txt");
		}
		downloadMode = missing.length > 0;
		if (downloadMode) {
			noDownload = false;
			for (const line of missing) {
				const data = line.trim().split("\t");
				if (data.length == 2) download_queue.push(data);
			}
			mediaDownload(download_queue);
		} else if (modifyMode || BATCH) {
			const queue = [];
			const lines = await readAllLines("queue.txt");
			for (const line of lines) {
				const url = line.trim().split("\t")[0];
				if (url.startsWith("https://app.memrise.com/community/course/")) {
					if (url in queue) {
						console.warn("duplicate:", url);
					} else {
						queue.push(url);
					}
				}
			}
			const total = queue.length;
			let done = 0;
			const pids = Array(Math.min(total, maxConnections)).fill().map((_, i) => i + 1);
			await Promise.allSettled(pids.map(async _ => {
				while (!stopping && queue.length) {
					const url = queue.shift();
					const prefix = `${total - queue.length}/${total}: `;
					// console.log(prefix + url);
					await CourseDownload(url, prefix);
					done++;
					if (queue.length) {
						for (const div of progressbar.getElementsByTagName('div')) {
							if (div.innerText.startsWith(prefix)) {
								progressbar.removeChild(div);
								break;
							}
						}
					}
				}
			}));
			// progressbar.className = "halfdone";
			mediaDownload(download_queue);
		} else {
			if (await CourseDownload(currentUrl) != -1) {
				mediaDownload(download_queue);
			}
		}
	} catch (err) {
		console.error(err);
	}
})();
