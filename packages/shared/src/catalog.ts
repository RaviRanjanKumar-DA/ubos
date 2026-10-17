// Ready business lines (workspaces) offered when onboarding a company or adding a workspace.
// `template` picks the starting pipeline stages; any other name can be typed in as a custom business line.
export const BUSINESS_LINES: { name: string; template: string; group: string }[] = [
  { name: 'Course / Software', template: 'software', group: 'Education & training' },
  { name: 'Education', template: 'education', group: 'Education & training' },
  { name: 'Coaching / Classes', template: 'education', group: 'Education & training' },
  { name: 'Workshops & Events', template: 'education', group: 'Education & training' },
  { name: 'Vastu Consultation / Audit', template: 'consulting', group: 'Consulting & advisory' },
  { name: 'Numerology', template: 'consulting', group: 'Consulting & advisory' },
  { name: 'Astrology', template: 'consulting', group: 'Consulting & advisory' },
  { name: 'Business Consulting', template: 'consulting', group: 'Consulting & advisory' },
  { name: 'Logo Designing', template: 'design_services', group: 'Creative & digital' },
  { name: 'Graphic & Brand Design', template: 'design_services', group: 'Creative & digital' },
  { name: 'Digital Marketing', template: 'design_services', group: 'Creative & digital' },
  { name: 'Website Development', template: 'software', group: 'Creative & digital' },
  { name: 'Software / SaaS', template: 'software', group: 'Creative & digital' },
  { name: 'Real Estate', template: 'real_estate', group: 'Sales & services' },
  { name: 'Insurance', template: 'insurance', group: 'Sales & services' },
  { name: 'Healthcare / Clinic', template: 'healthcare', group: 'Sales & services' },
  { name: 'Sales', template: 'other', group: 'Sales & services' },
  { name: 'Customer Support', template: 'other', group: 'Sales & services' },
];
