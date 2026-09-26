export interface NavItem {
  readonly href: string;
  readonly label: string;
}

export const NAV_ITEMS: readonly NavItem[] = [
  { href: '/coverage', label: 'Coverage' },
  { href: '/story', label: 'Our story' },
  { href: '/team', label: 'Join the team' },
  { href: '/contact', label: 'Contact' },
];
