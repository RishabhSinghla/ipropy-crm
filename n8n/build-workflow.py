#!/usr/bin/env python3
"""
Generates n8n/ipropy-content-factory.json.

Written as a generator rather than hand-authored JSON because every Code node
carries real JavaScript, and hand-escaping newlines and quotes inside JSON is
how you end up with a workflow that imports but does not run. Here the JS is an
ordinary Python string and json.dump does the escaping.

    python3 n8n/build-workflow.py

The media worker does every byte of file handling. n8n never touches OneDrive,
holds no Microsoft credentials and downloads no photographs — it asks the
worker what is there, decides labels and order, writes the words, and asks the
worker to publish. Two HTTP calls and some thinking in between.
"""
import json
import pathlib

OUT = pathlib.Path(__file__).with_name('ipropy-content-factory.json')

# Verified against OpenRouter's live API: $0.03/M in, $0.13/M out, 1M context,
# and — unlike DeepSeek V4 Flash — it accepts images.
MODEL = 'qwen/qwen3.7-flash'
WORKER = 'http://127.0.0.1:8712'

nodes: list[dict] = []
conns: dict[str, dict] = {}
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


CRM_CRED = {'httpHeaderAuth': {'id': 'ipropy-crm', 'name': 'iPropy CRM API key'}}
OR_CRED = {'httpHeaderAuth': {'id': 'openrouter', 'name': 'OpenRouter API key'}}
WORKER_CRED = {'httpHeaderAuth': {'id': 'media-worker', 'name': 'iPropy media worker token'}}

# ---------------------------------------------------------------------------
node('Shoot finished', 'n8n-nodes-base.webhook', {
    'httpMethod': 'POST',
    'path': 'ipropy-shoot-finished',
    'responseMode': 'responseNode',
    'options': {},
}, 0, type_version=2, extra={'webhookId': 'ipropy-shoot-finished'})

READ_JS = r"""
// One normalised object for everything downstream, so a change to the CRM's
// payload is a change in exactly one place.
const b = $json.body ?? $json;

const need = (k) => {
  const v = b[k];
  if (v === undefined || v === null || String(v).trim() === '') {
    throw new Error(`The CRM did not send "${k}". Nothing can be filed without it.`);
  }
  return String(v).trim();
};

return [{
  json: {
    propertyId: need('propertyId'),
    // Relative to the worker's root, e.g. "GREENFIELD/B12-4BHK-250SQYD".
    folder: need('folder').replace(/^\/+|\/+$/g, ''),
    sessionId: b.sessionId ?? null,
    crmBaseUrl: (b.crmBaseUrl ?? 'http://localhost:4000').replace(/\/+$/, ''),
    startedAt: new Date().toISOString(),
  },
}];
"""
node('Read the request', 'n8n-nodes-base.code',
     {'jsCode': READ_JS.strip()}, 220, type_version=2)

node('Get property from CRM', 'n8n-nodes-base.httpRequest', {
    'method': 'GET',
    'url': '={{ $json.crmBaseUrl }}/api/records/properties/{{ $json.propertyId }}',
    'authentication': 'genericCredentialType',
    'genericAuthType': 'httpHeaderAuth',
    'options': {'timeout': 30000},
}, 440, type_version=4.2, creds=CRM_CRED)

# --- the worker does the pixels -------------------------------------------
node('Worker: prepare', 'n8n-nodes-base.httpRequest', {
    'method': 'POST',
    'url': f'{WORKER}/prepare',
    'authentication': 'genericCredentialType',
    'genericAuthType': 'httpHeaderAuth',
    'sendBody': True,
    'specifyBody': 'json',
    'jsonBody': '={{ JSON.stringify({ folder: $(\'Read the request\').item.json.folder }) }}',
    # Decoding and correcting forty 4032x3024 photographs takes real time.
    'options': {'timeout': 900000},
}, 660, type_version=4.2, creds=WORKER_CRED)

SPLIT_JS = r"""
// One item per photo, each carrying its small preview.
const res = $input.first().json;
if (!res.previews || res.previews.length === 0) {
  throw new Error(
    `The worker found no usable photos in "${res.folder}". Either the upload ` +
    `has not finished syncing, or "01 Originals" is empty.`
  );
}
return res.previews.map((p) => ({ json: p }));
"""
node('Split previews', 'n8n-nodes-base.code',
     {'jsCode': SPLIT_JS.strip()}, 880, type_version=2)

node('Each photo', 'n8n-nodes-base.splitInBatches',
     {'batchSize': 1, 'options': {}}, 1100, type_version=3)

LOOK_BODY = {
    'model': MODEL,
    'temperature': 0,
    'response_format': {'type': 'json_object'},
    'messages': [
        {'role': 'system',
         'content': (
             'You label photographs of Indian builder-floor properties for an '
             'estate agency. JSON only, no prose: '
             '{"room":"two words at most","subject":"what it mainly shows, '
             'under 8 words","broken":true|false,"why":"only if broken"}. '
             'Use plain names a buyer would use: drawing room, kitchen, '
             'bedroom, bathroom, balcony, terrace, lobby, exterior, parking. '
             'Set broken=true ONLY for a photo that cannot be published at all '
             '— badly out of focus, a shot of the floor or a shoe, a '
             'screenshot, a document, or a picture of a person. A merely '
             'ordinary photo is not broken.'
         )},
        {'role': 'user', 'content': [
            {'type': 'text', 'text': '=Filename: {{ $json.master }}'},
            {'type': 'image_url', 'image_url': {'url': '={{ $json.preview }}'}},
        ]},
    ],
}
node('Look at the photo', 'n8n-nodes-base.httpRequest', {
    'method': 'POST',
    'url': 'https://openrouter.ai/api/v1/chat/completions',
    'authentication': 'genericCredentialType',
    'genericAuthType': 'httpHeaderAuth',
    'sendBody': True,
    'specifyBody': 'json',
    'jsonBody': '=' + json.dumps(LOOK_BODY),
    'options': {'timeout': 120000},
}, 1320, y=Y + 180, type_version=4.2, creds=OR_CRED)

COLLECT_JS = r"""
// A model that answers with junk must cost one label, never the run — so this
// never throws. An unlabelled photo is still published, just as "photo".
const meta = $('Each photo').first().json;
let seen = { room: 'photo', subject: '', broken: false };
try {
  seen = { ...seen, ...JSON.parse($json.choices[0].message.content) };
} catch {
  seen.subject = 'label unavailable';
}
return [{ json: { master: meta.master, ...seen } }];
"""
node('Collect label', 'n8n-nodes-base.code',
     {'jsCode': COLLECT_JS.strip()}, 1540, y=Y + 180, type_version=2,
     extra={'onError': 'continueRegularOutput'})

ORDER_JS = r"""
// Order, do not cull.
//
// The instruction is explicit: the photos are taken carefully, so nothing gets
// thrown away for being merely ordinary. The only things dropped are photos
// the model called genuinely unpublishable — a shot of a shoe, a screenshot —
// and even those are recorded with the reason rather than vanishing.
//
// What this DOES decide is sequence, and that matters more than culling: the
// photo sitting at position one on a 99acres listing is what decides whether
// anybody clicks at all.
const all = $input.all().map((i) => i.json);
const broken = all.filter((p) => p.broken);
const usable = all.filter((p) => !p.broken);

// The order a buyer wants to walk the property in.
const ROOM_ORDER = [
  'drawing room', 'living room', 'lobby', 'kitchen', 'dining',
  'bedroom', 'master bedroom', 'bathroom', 'balcony', 'terrace',
  'exterior', 'parking', 'staircase',
];
const rank = (room) => {
  const r = (room || '').toLowerCase();
  const i = ROOM_ORDER.findIndex((k) => r.includes(k) || k.includes(r));
  return i === -1 ? ROOM_ORDER.length : i;
};

// One of each room first, in walking order, then the remaining angles behind
// them in the same order. Eight views of one drawing room up front makes a
// good property look thin; the same eight further down are just detail.
const firstOfRoom = [];
const rest = [];
const seenRoom = new Set();
for (const p of [...usable].sort((a, b) => rank(a.room) - rank(b.room))) {
  const key = (p.room || 'photo').toLowerCase();
  (seenRoom.has(key) ? rest : firstOfRoom).push(p);
  seenRoom.add(key);
}

const plan = [...firstOfRoom, ...rest].map((p, i) => ({
  master: p.master,
  label: p.room || 'photo',
  order: i + 1,
  subject: p.subject,
}));

return [{ json: {
  plan,
  rooms: [...seenRoom],
  total: all.length,
  publishing: plan.length,
  dropped: broken.map((p) => ({ master: p.master, why: p.why || 'unpublishable' })),
} }];
"""
node('Put them in order', 'n8n-nodes-base.code',
     {'jsCode': ORDER_JS.strip()}, 1320, y=Y - 180, type_version=2)

WORDS_BODY = {
    'model': MODEL,
    'temperature': 0.4,
    'response_format': {'type': 'json_object'},
    'messages': [
        {'role': 'system',
         'content': (
             'You write listing copy for iPropy, an estate agency in Faridabad, '
             'Haryana. Plain Indian English. No emoji walls, no "DM for price", '
             'and never a fact you were not given — if a number is not in the '
             'data, do not state it. Prices in lakh and crore as Indians write '
             'them. JSON only: {"instagram":"...","facebook":"...",'
             '"whatsapp":"...","status_line":"...","google":"...",'
             '"shorts_title":"...","portal_title":"...",'
             '"portal_description":"...","hashtags":["..."]}. '
             'whatsapp must read like a message from a person, under 400 '
             'characters. status_line is one short line. shorts_title is under '
             '90 characters. portal_description is 4 to 6 sentences.'
         )},
        {'role': 'user',
         'content': ('=Property facts as JSON:\n'
                     '{{ JSON.stringify($(\'Get property from CRM\').item.json) }}'
                     '\n\nRooms photographed: {{ $json.rooms.join(", ") }}'
                     '\nPhotos being published: {{ $json.publishing }}')},
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
}, 1540, y=Y - 180, type_version=4.2, creds=OR_CRED)

BUILD_JS = r"""
// The three files a person actually opens, plus the plan the worker applies.
const cfg      = $('Read the request').first().json;
const ordered  = $('Put them in order').first().json;
const property = $('Get property from CRM').first().json;

let copy = {};
try { copy = JSON.parse($json.choices[0].message.content); } catch { copy = {}; }
const line = (s) => (s ?? '').toString().trim();
const tags = (copy.hashtags ?? []).map((h) => (h.startsWith('#') ? h : '#' + h)).join(' ');
const name = property.label ?? cfg.propertyId;

const captions = [
  `# Captions — ${name}`,
  ``,
  `Written ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC. Read before posting.`,
  ``,
  `## Instagram (feed + reel)`, ``, line(copy.instagram), ``, tags, ``,
  `## Facebook (page, groups, marketplace)`, ``, line(copy.facebook), ``,
  `## WhatsApp — send to a buyer`, ``, line(copy.whatsapp), ``,
  `## WhatsApp Status / Instagram Story`, ``, line(copy.status_line), ``,
  `## Google Business update`, ``, line(copy.google), ``,
  `## YouTube Shorts title`, ``, line(copy.shorts_title), ``,
].join('\n');

const listing = [
  `# Portal listing — ${name}`,
  ``,
  `For 99acres, MagicBricks, Housing, NoBroker and Facebook Marketplace.`,
  `Photos are in "03 Portals and Website", already in this order.`,
  ``,
  `**Title**`, ``, line(copy.portal_title), ``,
  `**Description**`, ``, line(copy.portal_description), ``,
  `---`, ``, `## Photo order`,
  ...ordered.plan.map((p) => `${p.order}. ${p.label}${p.subject ? ' — ' + p.subject : ''}`),
].join('\n');

const status = {
  ok: true,
  finished_at: new Date().toISOString(),
  started_at: cfg.startedAt,
  property_id: cfg.propertyId,
  folder: cfg.folder,
  model: 'qwen/qwen3.7-flash',
  photos_seen: ordered.total,
  photos_published: ordered.publishing,
  rooms: ordered.rooms,
  // Recorded, not hidden: a photo that disappeared without explanation is the
  // thing that makes people stop trusting the whole pipeline.
  not_published: ordered.dropped,
};

return [{ json: {
  plan: ordered.plan,
  files: {
    'captions.md': captions,
    'listing.md': listing,
    '_status.json': JSON.stringify(status, null, 2),
  },
  summary: `${ordered.publishing} photos published across 4 folders`,
} }];
"""
node('Build the files', 'n8n-nodes-base.code',
     {'jsCode': BUILD_JS.strip()}, 1760, y=Y - 180, type_version=2)

node('Worker: publish', 'n8n-nodes-base.httpRequest', {
    'method': 'POST',
    'url': f'{WORKER}/finish',
    'authentication': 'genericCredentialType',
    'genericAuthType': 'httpHeaderAuth',
    'sendBody': True,
    'specifyBody': 'json',
    'jsonBody': ('={{ JSON.stringify({'
                 'folder: $(\'Read the request\').item.json.folder,'
                 'plan: $json.plan,'
                 'files: $json.files'
                 '}) }}'),
    'options': {'timeout': 900000},
}, 1980, y=Y - 180, type_version=4.2, creds=WORKER_CRED)

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
}, 2200, y=Y - 180, type_version=4.2,
    creds={'httpHeaderAuth': {'id': 'crm-callback', 'name': 'iPropy CRM callback secret'}})

node('Answer the CRM', 'n8n-nodes-base.respondToWebhook', {
    'respondWith': 'json',
    'responseBody': ('={{ JSON.stringify({ ok: true, summary: '
                     '$(\'Build the files\').item.json.summary }) }}'),
    'options': {},
}, 2420, y=Y - 180, type_version=1)

# ---------------------------------------------------------------------------
connect('Shoot finished', 'Read the request')
connect('Read the request', 'Get property from CRM')
connect('Get property from CRM', 'Worker: prepare')
connect('Worker: prepare', 'Split previews')
connect('Split previews', 'Each photo')

connect('Each photo', 'Put them in order', out=0)   # done
connect('Each photo', 'Look at the photo', out=1)   # next photo
connect('Look at the photo', 'Collect label')
connect('Collect label', 'Each photo')

connect('Put them in order', 'Write the words')
connect('Write the words', 'Build the files')
connect('Build the files', 'Worker: publish')
connect('Worker: publish', 'Tell the CRM')
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
total = sum(len(v['main'][i]) for v in conns.values() for i in range(len(v['main'])))
print(f'wrote {OUT.name}: {len(nodes)} nodes, {total} connections')
