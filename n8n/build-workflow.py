#!/usr/bin/env python3
"""
Generates n8n/ipropy-content-factory.json.

Written as a generator rather than hand-authored JSON because every Code node
carries real JavaScript, and hand-escaping newlines and quotes inside JSON is
how you end up with a workflow that imports but does not run. Here the JS is an
ordinary Python string and json.dump does the escaping.

Re-run after editing:  python3 n8n/build-workflow.py
"""
import json
import pathlib

OUT = pathlib.Path(__file__).with_name('ipropy-content-factory.json')

# Verified against OpenRouter's live API on 2026-08-15: $0.03/M in, $0.13/M out,
# 1M context, and — unlike DeepSeek V4 Flash — it accepts images.
MODEL = 'qwen/qwen3.7-flash'

GRAPH = 'https://graph.microsoft.com/v1.0'

nodes = []
conns = {}
Y = 300


def node(name, kind, params, x, y=Y, type_version=1, creds=None, extra=None):
    n = {
        'parameters': params,
        'id': name.lower().replace(' ', '-').replace('(', '').replace(')', '')[:36],
        'name': name,
        'type': kind,
        'typeVersion': type_version,
        'position': [x, y],
    }
    if creds:
        n['credentials'] = creds
    if extra:
        n.update(extra)
    nodes.append(n)
    return name


def connect(src, dst, out=0):
    conns.setdefault(src, {'main': []})
    while len(conns[src]['main']) <= out:
        conns[src]['main'].append([])
    conns[src]['main'][out].append({'node': dst, 'type': 'main', 'index': 0})


ONEDRIVE = {'authentication': 'predefinedCredentialType',
            'nodeCredentialType': 'microsoftOneDriveOAuth2Api'}

# --------------------------------------------------------------------------
# 1. The CRM says a shoot is finished.
# --------------------------------------------------------------------------
node('Shoot finished', 'n8n-nodes-base.webhook', {
    'httpMethod': 'POST',
    'path': 'ipropy-shoot-finished',
    'responseMode': 'responseNode',
    'options': {},
}, 0, type_version=2, extra={'webhookId': 'ipropy-shoot-finished'})

READ_JS = r"""
// Everything downstream reads from one normalised object, so a change to the
// CRM's payload is a change in exactly one place.
//
// `folder` is the property's OneDrive path *relative to the drive root* — the
// CRM already knows it as `folderKey` and it looks like
// "IPROPY-PROPERTIES/GREENFIELD/B12-4BHK-250SQYD".
const b = $json.body ?? $json;

const need = (k) => {
  const v = b[k];
  if (v === undefined || v === null || String(v).trim() === '') {
    throw new Error(`The CRM did not send "${k}". Nothing can be filed without it.`);
  }
  return String(v).trim();
};

const folder = need('folder').replace(/^\/+|\/+$/g, '');

return [{
  json: {
    propertyId: need('propertyId'),
    folder,
    originalsPath: `${folder}/01 Originals`,
    sessionId: b.sessionId ?? null,
    crmBaseUrl: (b.crmBaseUrl ?? 'http://localhost:4000').replace(/\/+$/, ''),
    // A cap, not a target. Judging 200 photos would cost real money and the
    // agent picks ~12 anyway; the cap is what stops one bad shoot day
    // spending forty dollars.
    maxPhotos: Math.min(Number(b.maxPhotos ?? 40), 60),
    startedAt: new Date().toISOString(),
  },
}];
"""
node('Read the request', 'n8n-nodes-base.code',
     {'jsCode': READ_JS.strip()}, 220, type_version=2)

# --------------------------------------------------------------------------
# 2. Facts from the CRM, files from OneDrive.
# --------------------------------------------------------------------------
node('Get property from CRM', 'n8n-nodes-base.httpRequest', {
    'method': 'GET',
    'url': '={{ $json.crmBaseUrl }}/api/records/properties/{{ $json.propertyId }}',
    'authentication': 'genericCredentialType',
    'genericAuthType': 'httpHeaderAuth',
    'options': {'timeout': 30000},
}, 440, type_version=4.2,
    creds={'httpHeaderAuth': {'id': 'ipropy-crm', 'name': 'iPropy CRM API key'}})

node('List originals', 'n8n-nodes-base.httpRequest', dict(ONEDRIVE, **{
    'method': 'GET',
    'url': '={{ $(\'Read the request\').item.json.originalsPath.split("/").map(encodeURIComponent).join("/") }}',
    'options': {'timeout': 60000},
}), 660, type_version=4.2,
    creds={'microsoftOneDriveOAuth2Api': {'id': 'onedrive', 'name': 'OneDrive'}})
# The URL above is replaced below with the full Graph call; kept separate so the
# expression stays readable.
nodes[-1]['parameters']['url'] = (
    '=' + GRAPH + '/me/drive/root:/'
    '{{ $(\'Read the request\').item.json.originalsPath.split("/").map(encodeURIComponent).join("/") }}'
    ':/children?$top=200&$select=id,name,size,file,photo'
)

PICK_JS = r"""
// Only real images, newest last, capped. Anything OneDrive reports without a
// `file.mimeType` starting image/ is a folder, a document, or a sync artefact.
const cfg = $('Read the request').first().json;
const items = $input.first().json.value ?? [];

const photos = items
  .filter((f) => (f.file?.mimeType ?? '').startsWith('image/'))
  .filter((f) => (f.size ?? 0) > 40 * 1024)   // thumbnails and junk
  .sort((a, b) => (a.name > b.name ? 1 : -1))
  .slice(0, cfg.maxPhotos);

if (photos.length === 0) {
  throw new Error(
    `No photos in "${cfg.originalsPath}". Either the upload has not finished ` +
    `syncing, or the CRM sent the wrong folder.`
  );
}

return photos.map((f) => ({ json: { fileId: f.id, name: f.name, size: f.size } }));
"""
node('Pick photos to judge', 'n8n-nodes-base.code',
     {'jsCode': PICK_JS.strip()}, 880, type_version=2)

# --------------------------------------------------------------------------
# 3. Judge each photo. One at a time, so a single failure loses one photo.
# --------------------------------------------------------------------------
node('Each photo', 'n8n-nodes-base.splitInBatches',
     {'batchSize': 1, 'options': {}}, 1100, type_version=3)

node('Download photo', 'n8n-nodes-base.httpRequest', dict(ONEDRIVE, **{
    'method': 'GET',
    'url': '=' + GRAPH + '/me/drive/items/{{ $json.fileId }}/content',
    'options': {'response': {'response': {'responseFormat': 'file'}}, 'timeout': 120000},
}), 1320, y=Y + 160, type_version=4.2,
    creds={'microsoftOneDriveOAuth2Api': {'id': 'onedrive', 'name': 'OneDrive'}})

TO_DATA_URI_JS = r"""
// The vision model takes a data URI. n8n already holds the bytes as base64 on
// the binary property, so this is a rename rather than a re-encode.
const bin = $input.first().binary?.data;
if (!bin) throw new Error('OneDrive returned no file body for this photo.');

const meta = $('Each photo').first().json;
return [{
  json: {
    fileId: meta.fileId,
    name: meta.name,
    dataUri: `data:${bin.mimeType || 'image/jpeg'};base64,${bin.data}`,
  },
}];
"""
node('Photo to data URI', 'n8n-nodes-base.code',
     {'jsCode': TO_DATA_URI_JS.strip()}, 1540, y=Y + 160, type_version=2)

RATE_BODY = {
    'model': MODEL,
    'temperature': 0,
    'response_format': {'type': 'json_object'},
    'messages': [
        {'role': 'system',
         'content': (
             'You grade estate-agency photographs of Indian builder floors. '
             'Answer with JSON only, no prose: '
             '{"keep":true|false,"score":0-10,"room":"short label",'
             '"why":"under 12 words"}. '
             'Set keep=false for anything blurred, badly exposed, a duplicate '
             'angle of the same room, a picture of a person, a screenshot, or '
             'a document. Judge it as a buyer scrolling a listing would.'
         )},
        {'role': 'user', 'content': [
            {'type': 'text', 'text': '=Filename: {{ $json.name }}'},
            {'type': 'image_url', 'image_url': {'url': '={{ $json.dataUri }}'}},
        ]},
    ],
}
node('Rate photo', 'n8n-nodes-base.httpRequest', {
    'method': 'POST',
    'url': 'https://openrouter.ai/api/v1/chat/completions',
    'authentication': 'genericCredentialType',
    'genericAuthType': 'httpHeaderAuth',
    'sendBody': True,
    'specifyBody': 'json',
    'jsonBody': '=' + json.dumps(RATE_BODY),
    'options': {'timeout': 120000},
}, 1760, y=Y + 160, type_version=4.2,
    creds={'httpHeaderAuth': {'id': 'openrouter', 'name': 'OpenRouter API key'}})

COLLECT_JS = r"""
// A model that returns something unparseable must cost one photo, never the
// whole run — so this never throws.
const meta = $('Photo to data URI').first().json;
let verdict = { keep: false, score: 0, room: 'unknown', why: 'could not be read' };
try {
  verdict = { ...verdict, ...JSON.parse($json.choices[0].message.content) };
} catch (e) {
  verdict.why = `unreadable answer: ${String(e.message).slice(0, 60)}`;
}
return [{ json: { fileId: meta.fileId, name: meta.name, ...verdict } }];
"""
node('Collect rating', 'n8n-nodes-base.code',
     {'jsCode': COLLECT_JS.strip()}, 1980, y=Y + 160, type_version=2,
     extra={'onError': 'continueRegularOutput'})

# --------------------------------------------------------------------------
# 4. Shortlist, then write the words.
# --------------------------------------------------------------------------
SHORTLIST_JS = r"""
// Every rating this run produced.
const all = $input.all().map((i) => i.json);
const kept = all.filter((r) => r.keep).sort((a, b) => b.score - a.score);

// One photo per room first, then the best of the rest. A listing with eight
// angles of the same drawing room reads as a thin property even when it isn't.
const seen = new Set();
const firstOfEachRoom = [];
const remainder = [];
for (const r of kept) {
  const room = (r.room || 'unknown').toLowerCase();
  if (seen.has(room)) { remainder.push(r); } else { seen.add(room); firstOfEachRoom.push(r); }
}
const shortlist = [...firstOfEachRoom, ...remainder].slice(0, 12);

return [{
  json: {
    judged: all.length,
    kept: kept.length,
    shortlist,
    rejected: all.filter((r) => !r.keep),
    rooms: [...seen],
  },
}];
"""
node('Rank and shortlist', 'n8n-nodes-base.code',
     {'jsCode': SHORTLIST_JS.strip()}, 1320, y=Y - 160, type_version=2)

WORDS_BODY = {
    'model': MODEL,
    'temperature': 0.4,
    'response_format': {'type': 'json_object'},
    'messages': [
        {'role': 'system',
         'content': (
             'You write listing copy for iPropy, an estate agency in Faridabad, '
             'Haryana. Plain Indian English. No emoji walls, no "DM for price", '
             'no invented facts — if a number is not in the data you are given, '
             'do not state it. Prices in lakh/crore as Indians write them. '
             'Answer JSON only: {"instagram":"...","facebook":"...",'
             '"whatsapp":"...","portal_title":"...","portal_description":"...",'
             '"hashtags":["..."]}. WhatsApp text must be under 400 characters '
             'and readable as a message from a person, not an advert.'
         )},
        {'role': 'user',
         'content': ('=Property facts as JSON:\n{{ JSON.stringify($(\'Get property from CRM\').item.json) }}'
                     '\n\nRooms photographed: {{ $json.rooms.join(", ") }}'
                     '\nPhotos shortlisted: {{ $json.shortlist.length }}')},
    ],
}
node('Write the words', 'n8n-nodes-base.httpRequest', {
    'method': 'POST',
    'url': 'https://openrouter.ai/api/v1/chat/completions',
    'authentication': 'genericCredentialType',
    'genericAuthType': 'httpHeaderAuth',
    'sendBody': True,
    'specifyBody': 'json',
    'jsonBody': '=' + json.dumps(WORDS_BODY),
    'options': {'timeout': 180000},
}, 1540, y=Y - 160, type_version=4.2,
    creds={'httpHeaderAuth': {'id': 'openrouter', 'name': 'OpenRouter API key'}})

BUILD_JS = r"""
// Turns the two model answers into the handful of files a person opens.
const cfg      = $('Read the request').first().json;
const ranked   = $('Rank and shortlist').first().json;
const property = $('Get property from CRM').first().json;

let copy = {};
try { copy = JSON.parse($json.choices[0].message.content); } catch { copy = {}; }

const line = (s) => (s ?? '').toString().trim();
const captions = [
  `# Captions — ${property.label ?? cfg.propertyId}`,
  ``,
  `Written ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC. Read them before posting.`,
  ``,
  `## Instagram`, ``, line(copy.instagram), ``,
  (copy.hashtags?.length ? `${copy.hashtags.map((h) => (h.startsWith('#') ? h : '#' + h)).join(' ')}\n` : ''),
  `## Facebook`, ``, line(copy.facebook), ``,
  `## WhatsApp`, ``, line(copy.whatsapp), ``,
].join('\n');

const listing = [
  `# Portal listing — ${property.label ?? cfg.propertyId}`,
  ``,
  `**Title**`, ``, line(copy.portal_title), ``,
  `**Description**`, ``, line(copy.portal_description), ``,
  `---`,
  `Photos to upload, in this order:`,
  ...ranked.shortlist.map((p, i) => `${i + 1}. ${p.name}  — ${p.room} (${p.score}/10)`),
].join('\n');

const status = {
  ok: true,
  finished_at: new Date().toISOString(),
  started_at: cfg.startedAt,
  property_id: cfg.propertyId,
  folder: cfg.folder,
  model: 'qwen/qwen3.7-flash',
  photos_judged: ranked.judged,
  photos_kept: ranked.kept,
  photos_shortlisted: ranked.shortlist.length,
  rooms: ranked.rooms,
  wrote: ['_status.json', 'captions.md', 'listing.md', 'shortlist.json'],
  // Kept so a bad selection can be argued with rather than guessed at.
  rejected: ranked.rejected.map((r) => ({ name: r.name, why: r.why })),
};

return [{
  json: {
    captions,
    listing,
    shortlist: JSON.stringify({ shortlist: ranked.shortlist }, null, 2),
    status: JSON.stringify(status, null, 2),
    summary: `${ranked.shortlist.length} of ${ranked.judged} photos shortlisted`,
  },
}];
"""
node('Build the files', 'n8n-nodes-base.code',
     {'jsCode': BUILD_JS.strip()}, 1760, y=Y - 160, type_version=2)


def upload(label, filename, expr, x, y):
    node(label, 'n8n-nodes-base.httpRequest', dict(ONEDRIVE, **{
        'method': 'PUT',
        'url': ('=' + GRAPH + '/me/drive/root:/'
                '{{ $(\'Read the request\').item.json.folder.split("/").map(encodeURIComponent).join("/") }}'
                f'/{filename}:/content'),
        'sendBody': True,
        'contentType': 'raw',
        'rawContentType': 'text/plain; charset=utf-8',
        'body': expr,
        'options': {'timeout': 60000},
    }), x, y=y, type_version=4.2,
        creds={'microsoftOneDriveOAuth2Api': {'id': 'onedrive', 'name': 'OneDrive'}})
    return label


upload('Write captions.md', 'captions.md', '={{ $json.captions }}', 1980, Y - 320)
upload('Write listing.md', 'listing.md', '={{ $json.listing }}', 2200, Y - 320)
upload('Write shortlist.json', 'shortlist.json', '={{ $json.shortlist }}', 2420, Y - 320)
upload('Write _status.json', '_status.json', '={{ $json.status }}', 2640, Y - 320)

node('Tell the CRM', 'n8n-nodes-base.httpRequest', {
    'method': 'POST',
    'url': '={{ $(\'Read the request\').item.json.crmBaseUrl }}/api/webhooks/n8n/content-ready',
    'authentication': 'genericCredentialType',
    'genericAuthType': 'httpHeaderAuth',
    'sendBody': True,
    'specifyBody': 'json',
    'jsonBody': ('={{ JSON.stringify({'
                 'propertyId: $(\'Read the request\').item.json.propertyId,'
                 'sessionId: $(\'Read the request\').item.json.sessionId,'
                 'folder: $(\'Read the request\').item.json.folder,'
                 'summary: $(\'Build the files\').item.json.summary'
                 '}) }}'),
    'options': {'timeout': 30000},
}, 2860, y=Y - 320, type_version=4.2,
    creds={'httpHeaderAuth': {'id': 'ipropy-crm', 'name': 'iPropy CRM API key'}})

node('Answer the CRM', 'n8n-nodes-base.respondToWebhook', {
    'respondWith': 'json',
    'responseBody': ('={{ JSON.stringify({ ok: true, summary: '
                     '$(\'Build the files\').item.json.summary }) }}'),
    'options': {},
}, 3080, y=Y - 320, type_version=1)

# --------------------------------------------------------------------------
# Wiring. The loop is the only non-obvious part: Split In Batches sends
# "everything is done" out of output 0 and "here is the next one" out of 1.
# --------------------------------------------------------------------------
connect('Shoot finished', 'Read the request')
connect('Read the request', 'Get property from CRM')
connect('Get property from CRM', 'List originals')
connect('List originals', 'Pick photos to judge')
connect('Pick photos to judge', 'Each photo')

connect('Each photo', 'Rank and shortlist', out=0)   # done
connect('Each photo', 'Download photo', out=1)       # next photo
connect('Download photo', 'Photo to data URI')
connect('Photo to data URI', 'Rate photo')
connect('Rate photo', 'Collect rating')
connect('Collect rating', 'Each photo')              # back round

connect('Rank and shortlist', 'Write the words')
connect('Write the words', 'Build the files')
connect('Build the files', 'Write captions.md')
connect('Write captions.md', 'Write listing.md')
connect('Write listing.md', 'Write shortlist.json')
connect('Write shortlist.json', 'Write _status.json')
connect('Write _status.json', 'Tell the CRM')
connect('Tell the CRM', 'Answer the CRM')

workflow = {
    'name': 'iPropy — site visit to content',
    'nodes': nodes,
    'connections': conns,
    'settings': {'executionOrder': 'v1', 'saveManualExecutions': True},
    'pinData': {},
    'tags': [],
}

OUT.write_text(json.dumps(workflow, indent=2) + '\n')
print(f'wrote {OUT.name}: {len(nodes)} nodes, {sum(len(v["main"][i]) for v in conns.values() for i in range(len(v["main"])))} connections')
