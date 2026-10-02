import { ShapeIcon } from '../ShapeNode.jsx';

const EXTRA = {
  eye: <><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z" /><circle cx="12" cy="12" r="3" /></>,
  tag: <><path d="M3 12V4h8l10 10-8 8L3 12Z" /><circle cx="7.5" cy="8.5" r="1.3" /></>,
  up: <path d="m6 15 6-6 6 6" />,
  down: <path d="m6 9 6 6 6-6" />,
  left: <path d="m15 6-6 6 6 6" />,
  right: <path d="m9 6 6 6-6 6" />,
  swap: <><path d="M4 8h14l-3-3M20 16H6l3 3" /></>,
  fit: <><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" /></>,
  info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v6m0-9h.01" /></>,
  link: <><path d="M9 15 15 9M10 6l1-1a4 4 0 0 1 6 6l-1 1M14 18l-1 1a4 4 0 0 1-6-6l1-1" /></>,
  lane: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9.5h18M3 15h18" /></>,
  overview: <><rect x="3" y="5" width="18" height="14" rx="2" /><rect x="6.5" y="8.5" width="7" height="5" rx="1" /></>,
};

export default function FlowIcon({ name, size = 16, ...props }) {
  if (!EXTRA[name]) return <ShapeIcon name={name} size={size} {...props} />;
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>{EXTRA[name]}</svg>;
}
