/**
 * chat.ipropy.com — the assistant as a whole screen, the way ChatGPT looks.
 *
 * 11 October 2026, the owner: *"build one chat.ipropy.com right here right
 * now, a draft"*. Not a second assistant: it is `AiAssistant`, the same one the
 * sparkle bubble opens, with the same permission-scoped tools, history, memory
 * and confirm-before-change rule. One brain, two doors — a copy would drift.
 */
import { type JSX } from 'react';
import { useNavigate } from 'react-router-dom';
import AiAssistant from '../components/AiAssistant';

export default function AskPage(): JSX.Element {
  const navigate = useNavigate();
  return <AiAssistant open asPage onClose={() => navigate('/dashboard')} />;
}
