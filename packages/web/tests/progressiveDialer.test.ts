import { beforeEach, describe, expect, it } from 'vitest';
import { progressiveRecordUrl, useProgressiveDialer } from '../src/lib/progressiveDialer';

const queue = {
  userId: 'user-1',
  module: 'leads',
  sourceUrl: '/leads?view=hot&page=3&dial=1',
  items: [
    { id: 'a', label: 'Asha', number: '+919111111111' },
    { id: 'b', label: 'Bharat', number: '+919222222222' },
  ],
};

describe('progressive dialer session', () => {
  beforeEach(() => {
    useProgressiveDialer.setState({ session: null });
  });

  it('starts with the first selected record waiting for confirmation', () => {
    useProgressiveDialer.getState().start(queue);

    expect(useProgressiveDialer.getState().session).toMatchObject({
      userId: 'user-1', module: 'leads', index: 0, status: 'waiting',
    });
    expect(useProgressiveDialer.getState().session?.items[0]?.label).toBe('Asha');
  });

  it('advances one record and can pause before the next call', () => {
    useProgressiveDialer.getState().start(queue);

    expect(useProgressiveDialer.getState().advance(true)?.id).toBe('b');
    expect(useProgressiveDialer.getState().session).toMatchObject({ index: 1, status: 'paused' });

    useProgressiveDialer.getState().resume();
    expect(useProgressiveDialer.getState().session?.status).toBe('waiting');
    expect(useProgressiveDialer.getState().advance()).toBeNull();
    expect(useProgressiveDialer.getState().session?.status).toBe('completed');
  });

  it('keeps queue context while removing automatic dial flags', () => {
    useProgressiveDialer.getState().start(queue);
    const session = useProgressiveDialer.getState().session!;

    expect(progressiveRecordUrl(session, queue.items[1]!)).toBe('/leads?view=hot&page=3&open=b');
  });
});
