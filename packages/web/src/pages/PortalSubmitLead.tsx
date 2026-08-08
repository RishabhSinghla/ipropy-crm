import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import { ArrowLeft, User, Mail, Phone, MapPin, Building2, Home, Send, Loader2 } from 'lucide-react';
import { api } from '../lib/api';
import { toast } from '../lib/store';
import { Card, Spinner, Select, Input, Textarea } from '../components/ui';
import { PortalLayout } from './PortalDashboard';

const CONFIGURATION_OPTIONS = ['1 BHK', '2 BHK', '3 BHK', '4 BHK', 'Villa', 'Plot', 'Commercial'];

interface FormState {
  firstName: string;
  lastName: string;
  mobile: string;
  email: string;
  message: string;
  projectId: string;
  configuration: string[];
  budgetMin: string | number;
  budgetMax: string | number;
}

interface FormErrors {
  firstName?: string;
  mobile?: string;
  email?: string;
  budgetMin?: string;
  budgetMax?: string;
}

export default function PortalSubmitLead(): JSX.Element {
  const navigate = useNavigate();
  const [form, setForm] = useState<FormState>({
    firstName: '',
    lastName: '',
    mobile: '',
    email: '',
    message: '',
    projectId: '',
    configuration: [],
    budgetMin: '',
    budgetMax: '',
  });
  const [errors, setErrors] = useState<FormErrors>({});

  const { mutate: submitLead, isPending } = useMutation({
    mutationFn: (data: Record<string, unknown>) => api.portalSubmitLead(data),
    onSuccess: (result) => {
      if (result.status === 'created') {
        toast.success('Enquiry submitted', 'Your lead has been recorded and assigned.');
      } else if (result.status === 'duplicate') {
        toast.info('Already exists', 'This enquiry was merged with an existing one.');
      }
      navigate('/portal/leads');
    },
    onError: (err: Error) => {
      toast.error('Submission failed', err.message);
    },
  });

  const set = (patch: Partial<FormState>): void => {
    setForm((f) => ({ ...f, ...patch }));
    if (patch.firstName !== undefined) setErrors((e) => ({ ...e, firstName: '' }));
    if (patch.mobile !== undefined) setErrors((e) => ({ ...e, mobile: '' }));
    if (patch.email !== undefined) setErrors((e) => ({ ...e, email: '' }));
    if (patch.budgetMin !== undefined) setErrors((e) => ({ ...e, budgetMin: '' }));
    if (patch.budgetMax !== undefined) setErrors((e) => ({ ...e, budgetMax: '' }));
  };

  const validate = (): boolean => {
    const errs: FormErrors = {};
    if (!form.firstName.trim()) errs.firstName = 'First name is required';
    if (!form.mobile.trim() && !form.email.trim()) errs.mobile = 'Mobile or email is required';
    if (form.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) errs.email = 'Invalid email address';
    if (form.budgetMin && Number(form.budgetMin) < 0) errs.budgetMin = 'Must be positive';
    if (form.budgetMax && Number(form.budgetMax) < 0) errs.budgetMax = 'Must be positive';
    setErrors(errs);
    return Object.keys(errs).length === 0;
  };

  const handleSubmit = (e: React.FormEvent): void => {
    e.preventDefault();
    if (validate()) {
      submitLead({
        firstName: form.firstName.trim(),
        lastName: form.lastName.trim(),
        mobile: form.mobile.trim() || undefined,
        email: form.email.trim() || undefined,
        message: form.message.trim() || undefined,
        projectId: form.projectId || undefined,
        configuration: form.configuration,
        budgetMin: form.budgetMin ? Number(form.budgetMin) : undefined,
        budgetMax: form.budgetMax ? Number(form.budgetMax) : undefined,
      });
    }
  };

  const toggleConfig = (cfg: string): void => {
    set({ configuration: form.configuration.includes(cfg)
      ? form.configuration.filter((c) => c !== cfg)
      : [...form.configuration, cfg] });
  };

  return (
    <PortalLayout>
      <div className="max-w-2xl mx-auto">
        <div className="mb-6 flex items-center gap-3">
          <button onClick={() => navigate('/portal')} className="btn-ghost p-2">
            <ArrowLeft className="h-5 w-5" />
          </button>
          <div>
            <h2 className="text-2xl font-semibold">Submit New Enquiry</h2>
            <p className="text-sm text-muted">Enter the prospective buyer's details</p>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="space-y-5">
          <Card className="p-5 space-y-4">
            <h3 className="font-semibold flex items-center gap-2"><User className="h-5 w-5" /> Contact Details</h3>

            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className="label">First name <span className="text-negative">*</span></label>
                <Input
                  value={form.firstName}
                  onChange={(e) => set({ firstName: e.target.value })}
                  placeholder="First name"
                  error={errors.firstName}
                  autoFocus
                />
              </div>
              <div>
                <label className="label">Last name</label>
                <Input
                  value={form.lastName}
                  onChange={(e) => set({ lastName: e.target.value })}
                  placeholder="Last name"
                />
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className="label flex items-center gap-1">
                  <Phone className="h-4 w-4" /> Mobile
                </label>
                <Input
                  type="tel"
                  value={form.mobile}
                  onChange={(e) => set({ mobile: e.target.value })}
                  placeholder="+91 98765 43210"
                  error={errors.mobile}
                />
              </div>
              <div>
                <label className="label flex items-center gap-1">
                  <Mail className="h-4 w-4" /> Email
                </label>
                <Input
                  type="email"
                  value={form.email}
                  onChange={(e) => set({ email: e.target.value })}
                  placeholder="buyer@example.com"
                  error={errors.email}
                />
              </div>
            </div>

            <div>
              <label className="label">Message / Notes</label>
              <Textarea
                value={form.message}
                onChange={(e) => set({ message: e.target.value })}
                placeholder="Any specific requirements, timeline, or notes…"
                rows={3}
              />
            </div>
          </Card>

          <Card className="p-5 space-y-4">
            <h3 className="font-semibold flex items-center gap-2"><MapPin className="h-5 w-5" /> Property Requirements</h3>

            <div>
              <label className="label">Project (optional)</label>
              <Select
                value={form.projectId}
                onChange={(v) => set({ projectId: v })}
                placeholder="Select a project…"
                options={[{ value: '', label: '— No project —' }]}
              />
              <p className="mt-1 text-2xs text-muted">Projects list loads from the CRM. Select if the buyer has a specific project in mind.</p>
            </div>

            <div>
              <label className="label">Configuration</label>
              <div className="flex flex-wrap gap-2">
                {CONFIGURATION_OPTIONS.map((cfg) => (
                  <button
                    key={cfg}
                    type="button"
                    onClick={() => toggleConfig(cfg)}
                    className={`px-3 py-1.5 rounded-full text-sm border transition-colors ${
                      form.configuration.includes(cfg)
                        ? 'bg-purple-600 border-purple-600 text-white'
                        : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-50 dark:bg-slate-800 dark:border-slate-700 dark:text-slate-300'
                    }`}
                  >
                    {cfg}
                  </button>
                ))}
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className="label flex items-center gap-1">
                  <Building2 className="h-4 w-4" /> Budget Min (₹)
                </label>
                <Input
                  type="number"
                  value={form.budgetMin}
                  onChange={(e) => set({ budgetMin: e.target.value })}
                  placeholder="e.g. 5000000"
                  error={errors.budgetMin}
                />
              </div>
              <div>
                <label className="label flex items-center gap-1">
                  <Home className="h-4 w-4" /> Budget Max (₹)
                </label>
                <Input
                  type="number"
                  value={form.budgetMax}
                  onChange={(e) => set({ budgetMax: e.target.value })}
                  placeholder="e.g. 10000000"
                  error={errors.budgetMax}
                />
              </div>
            </div>
          </Card>

          <div className="flex gap-3">
            <button type="button" onClick={() => navigate('/portal')} className="btn-secondary flex-1">
              Cancel
            </button>
            <button type="submit" className="btn-primary flex-1" disabled={isPending}>
              {isPending && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
              <Send className="h-4 w-4 mr-2" /> Submit Enquiry
            </button>
          </div>
        </form>
      </div>
    </PortalLayout>
  );
}