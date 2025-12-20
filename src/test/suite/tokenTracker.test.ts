import * as assert from 'assert';

// Recreate pricing and calculation logic for testing
const PRICING = {
    'grok-3-mini': { inputPer1M: 0.30, outputPer1M: 0.50 },
    'grok-4': { inputPer1M: 3.00, outputPer1M: 15.00 },
    'default': { inputPer1M: 0.30, outputPer1M: 0.50 }
};

interface GrokUsage {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
}

interface SessionUsage {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    estimatedCostUsd: number;
    requestCount: number;
}

function calculateCost(usage: GrokUsage, model: string): number {
    const pricing = PRICING[model as keyof typeof PRICING] || PRICING['default'];
    const inputCost = (usage.promptTokens / 1_000_000) * pricing.inputPer1M;
    const outputCost = (usage.completionTokens / 1_000_000) * pricing.outputPer1M;
    return inputCost + outputCost;
}

function updateUsage(currentUsage: SessionUsage | null, usage: GrokUsage, model: string): SessionUsage {
    const sessionUsage = currentUsage || {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        estimatedCostUsd: 0,
        requestCount: 0
    };

    sessionUsage.promptTokens += usage.promptTokens;
    sessionUsage.completionTokens += usage.completionTokens;
    sessionUsage.totalTokens += usage.totalTokens;
    sessionUsage.requestCount += 1;
    sessionUsage.estimatedCostUsd += calculateCost(usage, model);

    return sessionUsage;
}

function formatUsageDisplay(usage: SessionUsage): string {
    const cost = usage.estimatedCostUsd.toFixed(4);
    return `${usage.totalTokens.toLocaleString()} tokens (~$${cost})`;
}

suite('Token Tracker - Cost Calculations', () => {

    test('calculates cost for grok-3-mini correctly', () => {
        const usage: GrokUsage = {
            promptTokens: 1000,
            completionTokens: 500,
            totalTokens: 1500
        };
        
        // grok-3-mini: $0.30/1M input, $0.50/1M output
        // Input: 1000 / 1_000_000 * 0.30 = 0.0003
        // Output: 500 / 1_000_000 * 0.50 = 0.00025
        // Total: 0.00055
        const cost = calculateCost(usage, 'grok-3-mini');
        
        assert.ok(Math.abs(cost - 0.00055) < 0.00001);
    });

    test('calculates cost for grok-4 correctly', () => {
        const usage: GrokUsage = {
            promptTokens: 1000,
            completionTokens: 500,
            totalTokens: 1500
        };
        
        // grok-4: $3.00/1M input, $15.00/1M output
        // Input: 1000 / 1_000_000 * 3.00 = 0.003
        // Output: 500 / 1_000_000 * 15.00 = 0.0075
        // Total: 0.0105
        const cost = calculateCost(usage, 'grok-4');
        
        assert.ok(Math.abs(cost - 0.0105) < 0.00001);
    });

    test('uses default pricing for unknown model', () => {
        const usage: GrokUsage = {
            promptTokens: 1000,
            completionTokens: 500,
            totalTokens: 1500
        };
        
        const cost = calculateCost(usage, 'unknown-model');
        const defaultCost = calculateCost(usage, 'grok-3-mini');
        
        assert.strictEqual(cost, defaultCost);
    });

    test('handles zero tokens', () => {
        const usage: GrokUsage = {
            promptTokens: 0,
            completionTokens: 0,
            totalTokens: 0
        };
        
        const cost = calculateCost(usage, 'grok-4');
        
        assert.strictEqual(cost, 0);
    });

    test('handles large token counts', () => {
        const usage: GrokUsage = {
            promptTokens: 100000,
            completionTokens: 50000,
            totalTokens: 150000
        };
        
        // grok-4: $3.00/1M input, $15.00/1M output
        // Input: 100000 / 1_000_000 * 3.00 = 0.30
        // Output: 50000 / 1_000_000 * 15.00 = 0.75
        // Total: 1.05
        const cost = calculateCost(usage, 'grok-4');
        
        assert.ok(Math.abs(cost - 1.05) < 0.001);
    });
});

suite('Token Tracker - Session Usage Tracking', () => {

    test('creates new session usage when null', () => {
        const usage: GrokUsage = {
            promptTokens: 100,
            completionTokens: 50,
            totalTokens: 150
        };
        
        const sessionUsage = updateUsage(null, usage, 'grok-3-mini');
        
        assert.strictEqual(sessionUsage.promptTokens, 100);
        assert.strictEqual(sessionUsage.completionTokens, 50);
        assert.strictEqual(sessionUsage.totalTokens, 150);
        assert.strictEqual(sessionUsage.requestCount, 1);
    });

    test('accumulates tokens across multiple requests', () => {
        const usage1: GrokUsage = { promptTokens: 100, completionTokens: 50, totalTokens: 150 };
        const usage2: GrokUsage = { promptTokens: 200, completionTokens: 100, totalTokens: 300 };
        
        let sessionUsage = updateUsage(null, usage1, 'grok-3-mini');
        sessionUsage = updateUsage(sessionUsage, usage2, 'grok-3-mini');
        
        assert.strictEqual(sessionUsage.promptTokens, 300);
        assert.strictEqual(sessionUsage.completionTokens, 150);
        assert.strictEqual(sessionUsage.totalTokens, 450);
        assert.strictEqual(sessionUsage.requestCount, 2);
    });

    test('accumulates cost across requests', () => {
        const usage1: GrokUsage = { promptTokens: 1000, completionTokens: 500, totalTokens: 1500 };
        const usage2: GrokUsage = { promptTokens: 1000, completionTokens: 500, totalTokens: 1500 };
        
        let sessionUsage = updateUsage(null, usage1, 'grok-3-mini');
        sessionUsage = updateUsage(sessionUsage, usage2, 'grok-3-mini');
        
        // Each request costs 0.00055, so total should be 0.0011
        assert.ok(Math.abs(sessionUsage.estimatedCostUsd - 0.0011) < 0.00001);
    });

    test('handles mixed model usage', () => {
        const usage1: GrokUsage = { promptTokens: 1000, completionTokens: 500, totalTokens: 1500 };
        const usage2: GrokUsage = { promptTokens: 1000, completionTokens: 500, totalTokens: 1500 };
        
        let sessionUsage = updateUsage(null, usage1, 'grok-3-mini'); // cost: 0.00055
        sessionUsage = updateUsage(sessionUsage, usage2, 'grok-4');  // cost: 0.0105
        
        // Total: 0.00055 + 0.0105 = 0.01105
        assert.ok(Math.abs(sessionUsage.estimatedCostUsd - 0.01105) < 0.00001);
        assert.strictEqual(sessionUsage.requestCount, 2);
    });
});

suite('Token Tracker - Display Formatting', () => {

    test('formats usage with small numbers', () => {
        const usage: SessionUsage = {
            promptTokens: 100,
            completionTokens: 50,
            totalTokens: 150,
            estimatedCostUsd: 0.0001,
            requestCount: 1
        };
        
        const display = formatUsageDisplay(usage);
        
        assert.ok(display.includes('150'));
        assert.ok(display.includes('$0.0001'));
    });

    test('formats usage with large numbers using locale string', () => {
        const usage: SessionUsage = {
            promptTokens: 100000,
            completionTokens: 50000,
            totalTokens: 150000,
            estimatedCostUsd: 1.05,
            requestCount: 10
        };
        
        const display = formatUsageDisplay(usage);
        
        // Should include comma separator for thousands
        assert.ok(display.includes('150,000') || display.includes('150000'));
        assert.ok(display.includes('$1.05'));
    });

    test('formats cost to 4 decimal places', () => {
        const usage: SessionUsage = {
            promptTokens: 1000,
            completionTokens: 500,
            totalTokens: 1500,
            estimatedCostUsd: 0.123456789,
            requestCount: 1
        };
        
        const display = formatUsageDisplay(usage);
        
        assert.ok(display.includes('$0.1235')); // rounded to 4 decimal places
    });
});

suite('Token Tracker - Pricing Verification', () => {

    test('grok-3-mini pricing is correct', () => {
        assert.strictEqual(PRICING['grok-3-mini'].inputPer1M, 0.30);
        assert.strictEqual(PRICING['grok-3-mini'].outputPer1M, 0.50);
    });

    test('grok-4 pricing is correct', () => {
        assert.strictEqual(PRICING['grok-4'].inputPer1M, 3.00);
        assert.strictEqual(PRICING['grok-4'].outputPer1M, 15.00);
    });

    test('grok-4 is 10x more expensive for input than grok-3-mini', () => {
        const ratio = PRICING['grok-4'].inputPer1M / PRICING['grok-3-mini'].inputPer1M;
        assert.strictEqual(ratio, 10);
    });

    test('grok-4 is 30x more expensive for output than grok-3-mini', () => {
        const ratio = PRICING['grok-4'].outputPer1M / PRICING['grok-3-mini'].outputPer1M;
        assert.strictEqual(ratio, 30);
    });
});
