/**
 * Press the button, find out.
 *
 * Every one of these does the smallest real version of the job it is testing.
 * Not a `/models` listing: an id can be listed and still be retired, out of
 * quota, scoped to the wrong account, or simply unable to see a picture. All of
 * those show up here as the same failure the CRM would hit halfway through a
 * property, which is the only thing a test button is for.
 *
 * Small enough to be free or nearly so. A test that costs money is a test
 * nobody presses, and an untested model id is how a feature is discovered to be
 * broken by a customer.
 */
import { complete } from './client.js';
import { embed, generateVideo, isMediaAiAvailable, music, rerank, speak, transcribe } from './media.js';
import { logger } from '../utils/logger.js';

export interface ModelTest {
  ok: boolean;
  message: string;
  /** How long the round trip took, so a working but unusably slow model shows. */
  ms?: number;
}

/** A 1x1 white JPEG. The smallest thing that proves a model can see. */
const PIXEL = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwc'
  + 'KDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAA'
  + 'AAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==',
  'base64',
);

export async function testMediaModel(job: string, model: string): Promise<ModelTest> {
  if (!isMediaAiAvailable() && job !== 'vision' && job !== 'copy') {
    return {
      ok: false,
      message: 'No OpenRouter key. Add one in Admin → Integrations; voice, music, transcription and search all go through it.',
    };
  }

  const started = Date.now();
  const ms = (): number => Date.now() - started;

  /*
    What the provider actually said.

    Every media call returns null on failure, so this file could only ever say
    "nothing came back" and then guess at why — telling an admin to "check the id
    is an embedding model" when what OpenRouter said was that the model does not
    exist, or that their key has no access to it. Four settings boxes read as
    broken features for want of a sentence that was already being logged.
  */
  let providerSaid = '';
  const onError = (message: string): void => { providerSaid = message; };

  /** The guess, unless the provider gave us something better. */
  const why = (fallback: string): string => (providerSaid
    ? `${fallback.split('.')[0]}. The provider said: ${providerSaid.slice(0, 240)}`
    : fallback);

  try {
    switch (job) {
      case 'vision': {
        const result = await complete({
          feature: 'model_test', system: 'Reply with the single word OK.',
          prompt: 'What colour is this image? Reply with one word.',
          images: [{ data: PIXEL, mimeType: 'image/jpeg' }],
          maxTokens: 512, model,
        });
        return result?.text.trim()
          ? { ok: true, message: `Answered: "${result.text.trim().slice(0, 60)}"`, ms: ms() }
          : { ok: false, message: 'It accepted the picture but said nothing back.', ms: ms() };
      }

      case 'copy': {
        const result = await complete({
          feature: 'model_test', system: 'Reply with the single word OK.',
          prompt: 'Say OK.', maxTokens: 512, model,
        });
        return result?.text.trim()
          ? { ok: true, message: `Answered: "${result.text.trim().slice(0, 60)}"`, ms: ms() }
          : { ok: false, message: 'No answer. The id may be retired or out of quota.', ms: ms() };
      }

      case 'speech': {
        const audio = await speak({ text: 'Testing.', model, onError });
        return audio?.length
          ? { ok: true, message: `Spoke ${(audio.length / 1024).toFixed(0)} KB of audio.`, ms: ms() }
          : { ok: false, message: why('No audio came back. Check the id is a text-to-speech model.'), ms: ms() };
      }

      case 'music': {
        const audio = await music('One short calm piano phrase.', { seconds: 5, model, onError });
        return audio?.length
          ? { ok: true, message: `Wrote ${(audio.length / 1024).toFixed(0)} KB of music.`, ms: ms() }
          : { ok: false, message: why('No audio came back. Check the id is a music model.'), ms: ms() };
      }

      case 'transcribe': {
        // Half a second of silence. A transcriber answers with an empty string,
        // which is a pass: it accepted the audio and returned the right shape.
        // Anything that cannot read audio at all fails before that.
        const silence = Buffer.concat([
          Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVEfmt '),
          Buffer.from([16, 0, 0, 0, 1, 0, 1, 0, 0x40, 0x1f, 0, 0, 0x80, 0x3e, 0, 0, 2, 0, 16, 0]),
          Buffer.from('data'), Buffer.alloc(4), Buffer.alloc(16_000),
        ]);
        const result = await transcribe(silence, 'wav', { model, onError });
        return result
          ? { ok: true, message: 'It read the audio.', ms: ms() }
          : { ok: false, message: why('It could not read the audio. Check the id is a transcription model.'), ms: ms() };
      }

      case 'embed': {
        const vectors = await embed(['a four bedroom builder floor in Faridabad'], { model, onError });
        return vectors?.[0]?.length
          ? { ok: true, message: `Returned a ${vectors[0].length}-number vector.`, ms: ms() }
          : { ok: false, message: why('No vector came back. Check the id is an embedding model.'), ms: ms() };
      }

      case 'rerank': {
        const hits = await rerank('parking', ['covered parking included', 'north facing terrace'], { model, onError });
        return hits?.length
          ? { ok: true, message: `Reordered ${hits.length} results.`, ms: ms() }
          : { ok: false, message: why('Nothing came back. Check the id is a reranking model.'), ms: ms() };
      }

      case 'video': {
        // The only test here that costs real money, so it is refused rather
        // than run. Two seconds of generated video is roughly three rupees, and
        // a button somebody taps out of curiosity should not have a bill.
        return {
          ok: true,
          message: 'Not tested, because generating even two seconds costs money. '
            + 'It is checked for real the first time a property reel is built with generation switched on.',
        };
      }

      default:
        return { ok: false, message: `There is no job called "${job}".` };
    }
  } catch (err) {
    logger.warn({ err, job, model }, 'model test failed');
    return { ok: false, message: err instanceof Error ? err.message.slice(0, 200) : 'The call failed.', ms: ms() };
  }
}
