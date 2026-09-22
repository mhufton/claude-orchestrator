# Holistic Workflow Example

> **Summary**: Real-world example showing how an orchestrator agent uses `/holistic` to deliver high-quality work on first attempt.

## Scenario

**Issue #456**: Add email notifications when payment fails

**Issue Body**:
```
When a payment attempt fails, we should send an email notification to the user
explaining what happened and how to retry. The email should include:
- Reason for failure
- Amount that failed
- Link to retry payment
- Support contact info
```

---

## Agent Workflow (With `/holistic`)

### Step 1: Agent Reads Prompt

```
Orchestrator spawns agent for issue #456...
Agent receives prompt with /holistic step...
```

### Step 2: Agent Runs Holistic Analysis

**Agent**: Let me start by running holistic analysis to understand the existing architecture.

```bash
/holistic "Issue #456: Add email notifications when payment fails"
```

**Holistic Analysis Output**:

```markdown
## 🔍 Holistic Analysis Summary

### Code Reuse Opportunities

✅ FOUND: Existing notification system
   - File: server/notifications/email-service.ts:23
   - Pattern: Template-based email sending with SendGrid
   - Usage example: server/auth/reset-password.ts:89 (password reset emails)
   - Recommendation: Extend existing EmailService class

✅ FOUND: Payment webhook handler
   - File: server/webhooks/stripe-webhook.ts:156
   - Pattern: Webhook → validate → process → notify
   - Currently handles: successful payments
   - Recommendation: Add failure branch to existing handler

✅ FOUND: Email templates
   - Directory: server/notifications/templates/
   - Existing: welcome.html, password-reset.html, payment-success.html
   - Pattern: Handlebars templates with variables
   - Recommendation: Create payment-failure.html following same pattern

### What's Changing
- Category: Backend (webhooks, notifications)
- Files likely affected:
  - server/webhooks/stripe-webhook.ts (add failure handling)
  - server/notifications/email-service.ts (add new template method)
  - server/notifications/templates/ (new template)
- Scope: Small (extending existing functionality)

### Dependencies & Impact
- Direct dependencies: Stripe webhook processing
- Indirect dependencies: Email service (already exists)
- Breaking changes: None (additive only)

### Pattern Consistency
✅ Follows existing pattern: server/auth/reset-password.ts:89
```typescript
// Example from existing code:
await emailService.sendPasswordReset({
  to: user.email,
  variables: {
    resetLink: link,
    userName: user.name
  }
});
```
Use same pattern for payment failure notification.

### End-to-End Flow
```
Stripe → Webhook Endpoint → Validate Signature →
  → [NEW] Check event type = payment_failed →
  → [NEW] Extract user email + failure reason →
  → [EXISTING] EmailService.send() →
  → SendGrid → Customer Email
```

### Risks
- Low: No breaking changes
- Low: Email templates are isolated
- Medium: Need to handle PII properly (payment amounts in emails)

### Recommended Actions
1. Extend server/webhooks/stripe-webhook.ts with payment failure case
2. Add sendPaymentFailure() method to EmailService following existing pattern
3. Create payment-failure.html template matching existing template style
4. Add tests for webhook failure handling (follow server/webhooks/stripe-webhook.test.ts pattern)
5. Test with Stripe webhook testing CLI

### Questions to Resolve
- None - approach is clear from existing patterns
```

### Step 3: Agent Plans Implementation

**Agent**: Based on the holistic analysis, I have a clear path:

**Plan:**
1. Extend `server/webhooks/stripe-webhook.ts` - add failure event handling
2. Add `sendPaymentFailure()` to `EmailService` (following existing methods)
3. Create `payment-failure.html` template (copy structure from `payment-success.html`)
4. Add tests (following `stripe-webhook.test.ts` pattern)

This reuses all existing infrastructure. No new services needed.

### Step 4: Agent Implements (Following Discovered Patterns)

**Agent**: Implementing by extending existing code...

**File 1: server/webhooks/stripe-webhook.ts**

```typescript
// Agent extends existing webhook handler
export async function handleStripeWebhook(req, res) {
  const event = await validateWebhook(req);

  switch (event.type) {
    case 'payment_intent.succeeded':
      await handlePaymentSuccess(event);
      break;

    // NEW CODE (following existing pattern)
    case 'payment_intent.payment_failed':
      await handlePaymentFailure(event);
      break;

    default:
      console.log(`Unhandled event type ${event.type}`);
  }

  res.json({ received: true });
}

// NEW FUNCTION (following existing pattern from handlePaymentSuccess)
async function handlePaymentFailure(event: Stripe.Event) {
  const paymentIntent = event.data.object as Stripe.PaymentIntent;
  const user = await getUserByPaymentIntent(paymentIntent.id);

  await emailService.sendPaymentFailure({
    to: user.email,
    variables: {
      userName: user.name,
      amount: formatCurrency(paymentIntent.amount),
      failureReason: paymentIntent.last_payment_error?.message || 'Unknown error',
      retryLink: `${process.env.APP_URL}/payment/retry/${paymentIntent.id}`,
      supportEmail: process.env.SUPPORT_EMAIL
    }
  });
}
```

**File 2: server/notifications/email-service.ts**

```typescript
// Agent extends EmailService class
export class EmailService {
  // ... existing methods (sendWelcome, sendPasswordReset, etc.)

  // NEW METHOD (following exact same pattern as existing methods)
  async sendPaymentFailure(params: {
    to: string;
    variables: {
      userName: string;
      amount: string;
      failureReason: string;
      retryLink: string;
      supportEmail: string;
    };
  }) {
    return this.send({
      to: params.to,
      subject: 'Payment Failed - Action Required',
      template: 'payment-failure',
      variables: params.variables
    });
  }
}
```

**File 3: server/notifications/templates/payment-failure.html**

```html
<!-- Agent copies structure from payment-success.html -->
<!DOCTYPE html>
<html>
<head>
  <style>
    /* Same styling as payment-success.html */
  </style>
</head>
<body>
  <div class="container">
    <h1>Payment Failed</h1>
    <p>Hi {{userName}},</p>
    <p>We were unable to process your payment of {{amount}}.</p>

    <div class="error-box">
      <strong>Reason:</strong> {{failureReason}}
    </div>

    <a href="{{retryLink}}" class="btn">Retry Payment</a>

    <p>If you continue to experience issues, please contact us at {{supportEmail}}.</p>
  </div>
</body>
</html>
```

**File 4: server/webhooks/stripe-webhook.test.ts**

```typescript
// Agent extends existing test file
describe('Stripe Webhook Handler', () => {
  // ... existing tests ...

  // NEW TEST (following exact pattern of existing success test)
  describe('payment_intent.payment_failed', () => {
    it('should send failure email to user', async () => {
      const mockEvent = createMockWebhookEvent('payment_intent.payment_failed', {
        id: 'pi_123',
        amount: 5000,
        last_payment_error: {
          message: 'Your card was declined'
        }
      });

      await handleStripeWebhook(mockEvent);

      expect(emailService.sendPaymentFailure).toHaveBeenCalledWith({
        to: 'user@example.com',
        variables: expect.objectContaining({
          amount: '$50.00',
          failureReason: 'Your card was declined'
        })
      });
    });
  });
});
```

### Step 5: Agent Tests

**Agent**: Running tests following the workflow...

```bash
queue-run test npm test
# ✓ All tests pass (including new payment failure test)

queue-run lint npm run lint
# ✓ No linting errors

queue-run build npm run build
# ✓ Build successful
```

### Step 6: Agent Creates PR

**Agent**: Creating pull request...

**PR Title**: Fix issue #456: Add email notifications for failed payments

**PR Body**:
```markdown
## Summary
- Added email notifications when payment fails
- Reuses existing notification infrastructure (EmailService)
- Follows established pattern from password reset and payment success emails

## Changes
- Extended Stripe webhook handler to process payment_failed events
- Added sendPaymentFailure() method to EmailService
- Created payment-failure.html template matching existing style
- Added comprehensive tests following existing test patterns

## Test plan
- [x] Unit tests pass
- [x] Linting passes
- [x] Build succeeds
- [x] Tested with Stripe webhook CLI

Closes #456
```

### Step 7: Handoff Notes

**Agent**: Writing handoff notes...

**File: .claude-handoff.md**
```markdown
# Handoff Notes for Issue #456

## Holistic Analysis Summary
- Existing patterns found:
  - EmailService in server/notifications/email-service.ts
  - Template pattern from password-reset.html
  - Webhook handler pattern from payment success case
- New patterns created: None (100% reuse of existing patterns)
- Dependencies affected: None (isolated change to webhook handler)

## What I Did
- Extended Stripe webhook handler with payment_failed event case
- Added sendPaymentFailure() method to EmailService (following existing method pattern)
- Created HTML template matching existing template structure
- Added tests following existing test suite patterns

## How It Works
- Stripe sends payment_failed webhook event
- Handler extracts user info and failure reason
- Calls EmailService.sendPaymentFailure() with template variables
- SendGrid delivers email using our existing template system

## Watch Out For
- PII handling: Payment amounts are included in emails (considered acceptable per support team)
- Retry link expires after 48 hours (standard Stripe behavior)
- Email template uses same styling as other transactional emails

## If This Fails Review
- Check Stripe webhook signature validation is working
- Verify SendGrid API key has send permissions
- Test email template rendering with real variables
- Check that getUserByPaymentIntent() correctly maps payment to user
```

### Step 8: Review

**Reviewer**: Checking out PR...

**Review Output**:
```
QUALITY_SCORE: 94

## PR Essence

**Intent:** Add email notifications to users when payment processing fails
**Scope:** small feature
**Achievement:** Yes - fully implements notification on payment failure

## Scoring

Starting score: 100

Deductions:
- [-3 points] Could add retry logic for email send failures (minor - existing code doesn't have this either)
- [-2 points] Email template could use i18n but not required for v1
- [-1 point] Missing monitoring/logging for failed email sends (nice-to-have)

Final Score: 94/100

Breakdown:
- Code Quality: 19/20 (excellent pattern consistency)
- Test Coverage: 20/20 (comprehensive tests following established patterns)
- Security: 28/30 (PII in emails - acceptable but noted)
- Correctness: 27/30 (works correctly, minor edge case handling)

## Summary

Excellent implementation that reuses existing infrastructure perfectly.
Follows all established patterns, has comprehensive tests, and solves the
stated problem. The consistency with existing code makes this very maintainable.
```

### Step 9: Auto-Merge

```
Score >= 90 AND CI passing → Auto-merge ✓

PR #789 merged to dev branch
Issue #456 closed
Ticket moved to "Done"
```

---

## Comparison: Without `/holistic`

### What Would Have Happened Without Holistic Analysis

**Agent would likely:**
1. Create NEW notification service (duplicate)
2. Use different email library (inconsistent)
3. Invent new template format (inconsistent)
4. Miss existing webhook patterns
5. Create different test structure

**Result:**
- 200+ lines of duplicate code
- Inconsistent with existing patterns
- Review score: ~75/100 (works but not maintainable)
- Retry required to match patterns
- Total time: 2-3 attempts instead of 1

---

## Key Takeaways

### What Made This Successful

1. **Ran `/holistic` FIRST** - Found all existing patterns before coding
2. **Followed recommendations** - Extended existing code instead of creating new
3. **Used pattern examples** - Copied structure from successful existing code
4. **High first-attempt score** - 94/100 due to pattern consistency
5. **Auto-merged** - No human intervention needed

### Time Savings

| Metric | Without /holistic | With /holistic | Improvement |
|--------|-------------------|----------------|-------------|
| Attempts needed | 2-3 | 1 | 67% reduction |
| Lines of code | 350 | 120 | 66% less code |
| Review score | 75 | 94 | +19 points |
| Time to merge | 4-6 hours | 1 hour | 75% faster |
| Human intervention | Required | None | Fully autonomous |

### Agent Learning

The handoff notes capture:
- Which patterns were reused (for future agents to learn from)
- Dependencies that were affected (for impact analysis)
- Decisions made (for consistency)

This creates a **learning flywheel** where each agent improves the pattern library for future agents.

---

## Next Steps

1. **Monitor metrics** - Track first-attempt scores with/without holistic
2. **Refine prompts** - Adjust based on what agents discover
3. **Build pattern library** - Document common patterns holistic finds
4. **Optimize queries** - Improve holistic search for your codebase

**Goal**: 80%+ auto-merge rate with high quality scores on first attempt.
