import { useState } from 'react';
import { BadgeCheck, KeyRound, LockKeyhole, X } from 'lucide-react';
import { useForm } from 'react-hook-form';
import { useAuthorizeRfid } from '@workspace/api-client-react';
import { Form, FormControl, FormField, FormItem, FormLabel } from '@/components/ui/form';

interface UnlockModalProps {
  onClose: () => void;
  onUnlock: () => void;
}

export function UnlockModal({ onClose, onUnlock }: UnlockModalProps) {
  const [message, setMessage] = useState('');
  const form = useForm<{ code: string }>({ defaultValues: { code: '' } });
  const authorizeRfid = useAuthorizeRfid();

  async function submit(values: { code: string }) {
    setMessage('');
    try {
      const result = await authorizeRfid.mutateAsync({
        data: { uid: values.code.trim() },
      });
      if (result.authorized) {
        onUnlock();
      } else {
        setMessage('Credential not registered. Try an allowed RFID code.');
      }
    } catch {
      setMessage('Authorization service unavailable. Try again shortly.');
    }
  }

  return (
    <div className="modal-scrim" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="unlock-modal" role="dialog" aria-modal="true" aria-labelledby="unlock-title">
        <button type="button" className="modal-close" onClick={onClose} aria-label="Close unlock dialog" data-testid="button-close-unlock">
          <X size={17} />
        </button>
        <div className="modal-emblem"><LockKeyhole size={20} /></div>
        <div className="eyebrow">OPERATOR AUTHENTICATION</div>
        <h2 id="unlock-title">Unlock monitor view</h2>
        <p>Read-only telemetry is currently masked. Authenticate to reveal this browser session’s monitoring data.</p>
        <Form {...form}>
        <form onSubmit={form.handleSubmit(submit)}>
          <FormField
            control={form.control}
            name="code"
            render={({ field }) => (
              <FormItem>
                <FormLabel htmlFor="rfid-code">RFID CREDENTIAL / DEMO</FormLabel>
                <div className="credential-input">
                  <KeyRound size={16} />
                  <FormControl>
                    <input
                      {...field}
                      id="rfid-code"
                      autoFocus
                      onChange={(event) => field.onChange(event.target.value.toUpperCase())}
                      placeholder="ENTER CARD CODE"
                      autoComplete="off"
                      required
                      data-testid="input-rfid-code"
                    />
                  </FormControl>
                  <span>HEX</span>
                </div>
              </FormItem>
            )}
          />
          {message && <div className="auth-error" role="alert">{message}</div>}
          <button type="submit" className="button-primary modal-submit" disabled={authorizeRfid.isPending} data-testid="button-submit-unlock">
            <BadgeCheck size={16} /> {authorizeRfid.isPending ? 'Verifying…' : 'Verify credential'}
          </button>
        </form>
        </Form>
        <div className="modal-footnote">Authentication grants operator command privileges. Live telemetry remains accessible in read-only emergency mode.</div>
      </section>
    </div>
  );
}
