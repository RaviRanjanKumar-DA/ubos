export interface Meta { departments: { id: string; name: string }[]; unlinkedUsers: { id: string; name: string; email: string }[]; onboardingTasks: string[]; exitTasks: string[]; docTypes: string[]; can: { manage: boolean; sensitive: boolean; assets: boolean } }
export interface Emp { id: string; employeeCode: string; name: string; mobile: string | null; workEmail: string | null; designation: string | null; departmentId: string | null; employmentType: string; workLocation: string | null; joiningDate: string; probationEnd: string | null; exitDate: string | null; exitReason: string | null; status: string; noticeDays: number; userId: string | null; dateOfBirth: string | null; department: { name: string } | null; user: { name: string; isActive: boolean } | null }

export const STATUS: Record<string, [string, string]> = { onboarding: ['warn', 'Joining'], active: ['ok', 'Working'], notice: ['bad', 'On notice'], exited: ['grey', 'Left'] };
export const TYPES: [string, string][] = [['full_time', 'Full time'], ['part_time', 'Part time'], ['contract', 'Contract'], ['intern', 'Intern']];
export const hrDate = (d: string | null) => (d ? new Date(d).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric' }) : '—');
export const istYmd = (d: string | null) => (d ? new Date(d).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }) : '');

export type Draft = { name: string; mobile: string; workEmail: string; designation: string; departmentId: string; employmentType: string; workLocation: string; joiningOn: string; probationEndOn: string; dateOfBirthOn: string; personalEmail: string; address: string; emergencyName: string; emergencyPhone: string; noticeDays: string; userId: string };
export const blankDraft = (today: string): Draft => ({ name: '', mobile: '', workEmail: '', designation: '', departmentId: '', employmentType: 'full_time', workLocation: '', joiningOn: today, probationEndOn: '', dateOfBirthOn: '', personalEmail: '', address: '', emergencyName: '', emergencyPhone: '', noticeDays: '30', userId: '' });
export const draftBody = (d: Draft, withUser: boolean) => ({
  name: d.name, mobile: d.mobile.trim() || null, workEmail: d.workEmail.trim() || null, designation: d.designation.trim() || null, departmentId: d.departmentId || null, employmentType: d.employmentType, workLocation: d.workLocation.trim() || null,
  joiningOn: d.joiningOn, probationEndOn: d.probationEndOn || null, dateOfBirthOn: d.dateOfBirthOn || null, personalEmail: d.personalEmail.trim() || null, address: d.address.trim() || null, emergencyName: d.emergencyName.trim() || null, emergencyPhone: d.emergencyPhone.trim() || null,
  noticeDays: Number(d.noticeDays) || 0, ...(withUser ? { userId: d.userId || null } : {}),
});
