/**
 * Explicit registry of every lucide icon that metadata can name.
 *
 * Module icons, timeline entry icons and the admin module builder's picker all
 * store a kebab-case *string* (`'map-pinned'`), resolved to a component at
 * runtime. The obvious implementation is `import * as Icons from 'lucide-react'`
 * plus `Icons[pascalCase(name)]` — and that was the implementation, but a
 * namespace import is opaque to tree-shaking, so it pulled all ~1,600 lucide
 * icons into the main bundle to render the ~35 the app can actually ask for.
 * That was the single largest thing in the entry chunk, paid for on first load
 * by every user, on every device, including the phones this now has to work on.
 *
 * Named imports let the bundler drop the rest. The trade-off is that this map
 * has to be kept in step with the names metadata uses:
 *
 *   - the seed's module icons        (db/seed/modules.ts, `icon:`)
 *   - the timeline's entry icons     (core/entity/timeline.ts)
 *   - the admin module builder's picker (pages/admin/ModuleBuilder.tsx ICONS)
 *
 * An unknown name is not an error — `resolveIcon` falls back to a neutral box,
 * which is the same thing the namespace lookup did for a typo. Adding a new
 * choice to the picker means adding it here too; the picker list is the
 * authoritative set of what an admin can choose, so the two are checked
 * together in the icon-registry test.
 */
import {
  AlertCircle, BarChart3, Box, Briefcase, Building, Building2, CalendarCheck, CheckCircle2, Circle,
  CircleDashed, ClipboardList, Contact, FileSignature, FileText, Flag, FolderOpen, Gift, Hammer,
  Handshake, Home, Key, Landmark, LayoutDashboard, LayoutGrid, Mail, Map, MapPinned, Megaphone, Newspaper,
  MessageCircle, MessageSquare, Package, Paperclip, Pencil, Phone, PhoneMissed, PlusCircle,
  ReceiptIndianRupee, Send, Shield, Sparkles, Star, Ticket, Trash2, Truck, Users, Wrench,
} from 'lucide-react';
import { Wand2 } from 'lucide-react';
import type { ComponentType } from 'react';

export type IconComponent = ComponentType<{ className?: string }>;

const REGISTRY: Record<string, IconComponent> = {
  // Module icons — db/seed/modules.ts
  briefcase: Briefcase,
  'building-2': Building2,
  'calendar-check': CalendarCheck,
  'file-signature': FileSignature,
  'folder-open': FolderOpen,
  handshake: Handshake,
  home: Home,
  landmark: Landmark,
  'map-pinned': MapPinned,
  megaphone: Megaphone,
  'receipt-indian-rupee': ReceiptIndianRupee,
  users: Users,
  contact: Contact,

  // Timeline entry icons — core/entity/timeline.ts
  'alert-circle': AlertCircle,
  'check-circle-2': CheckCircle2,
  'circle-dashed': CircleDashed,
  circle: Circle,
  mail: Mail,
  'message-circle': MessageCircle,
  'message-square': MessageSquare,
  paperclip: Paperclip,
  pencil: Pencil,
  phone: Phone,
  'phone-missed': PhoneMissed,
  'plus-circle': PlusCircle,
  sparkles: Sparkles,
  'trash-2': Trash2,

  // Admin module-builder picker — pages/admin/ModuleBuilder.tsx
  box: Box,
  building: Building,
  'clipboard-list': ClipboardList,
  'file-text': FileText,
  flag: Flag,
  gift: Gift,
  hammer: Hammer,
  key: Key,
  map: Map,
  package: Package,
  shield: Shield,
  star: Star,
  ticket: Ticket,
  truck: Truck,
  wrench: Wrench,

  // Navigation entries that pass a name through the same resolver
  'layout-dashboard': LayoutDashboard,
  'layout-grid': LayoutGrid,
  'wand-2': Wand2,
  send: Send,
  newspaper: Newspaper,
  'bar-chart-3': BarChart3,
};

/** Look up a metadata icon name; unknown names degrade to a neutral box rather than crashing a render. */
export function resolveIcon(name: string | null | undefined): IconComponent {
  if (!name) return Box;
  return REGISTRY[name] ?? Box;
}

/** Names the registry knows — used by the test that keeps it in step with the admin picker. */
export const REGISTERED_ICON_NAMES = Object.keys(REGISTRY);
