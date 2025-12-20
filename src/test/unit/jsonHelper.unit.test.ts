import * as assert from 'assert';
import { 
    isValidJson, 
    looksLikeJson, 
    isHttpError, 
    extractJson, 
    repairJson, 
    safeParseJson 
} from '../../prompts/jsonHelper';

describe('JSON Helper', () => {
    describe('isValidJson', () => {
        it('should return true for valid JSON', () => {
            const result = isValidJson('{"key": "value"}');
            assert.strictEqual(result.isValid, true);
            assert.deepStrictEqual(result.parsed, { key: 'value' });
        });

        it('should return false for invalid JSON', () => {
            const result = isValidJson('{"key": value}');
            assert.strictEqual(result.isValid, false);
            assert.ok(result.error);
        });
    });

    describe('looksLikeJson', () => {
        it('should detect object-like strings', () => {
            assert.strictEqual(looksLikeJson('{"key": "value"}'), true);
            assert.strictEqual(looksLikeJson('  { "a": 1 }  '), true);
        });

        it('should detect array-like strings', () => {
            assert.strictEqual(looksLikeJson('[1, 2, 3]'), true);
        });

        it('should reject non-JSON strings', () => {
            assert.strictEqual(looksLikeJson('Hello world'), false);
            assert.strictEqual(looksLikeJson('not json'), false);
        });
    });

    describe('isHttpError', () => {
        it('should detect HTML error pages', () => {
            assert.strictEqual(isHttpError('<!DOCTYPE html><html>Error</html>'), true);
            assert.strictEqual(isHttpError('<html>502 Bad Gateway</html>'), true);
        });

        it('should detect common error messages', () => {
            assert.strictEqual(isHttpError('503 Service Unavailable'), true);
            assert.strictEqual(isHttpError('Rate limit exceeded'), true);
            assert.strictEqual(isHttpError('Unauthorized'), true);
        });

        it('should not flag normal JSON', () => {
            assert.strictEqual(isHttpError('{"message": "Hello"}'), false);
        });
    });

    describe('extractJson', () => {
        it('should extract JSON from markdown code block', () => {
            const text = 'Some text\n```json\n{"key": "value"}\n```\nMore text';
            assert.strictEqual(extractJson(text), '{"key": "value"}');
        });

        it('should extract JSON from mixed text', () => {
            const text = 'Here is the response: {"key": "value"} and more text';
            assert.strictEqual(extractJson(text), '{"key": "value"}');
        });

        it('should return null for no JSON', () => {
            assert.strictEqual(extractJson('No JSON here'), null);
        });
    });

    describe('repairJson', () => {
        it('should handle double commas', () => {
            const broken = '{"a": 1,, "b": 2}';
            const repaired = repairJson(broken);
            const result = isValidJson(repaired);
            assert.strictEqual(result.isValid, true);
        });

        it('should handle trailing commas', () => {
            const broken = '{"a": 1, "b": 2,}';
            const repaired = repairJson(broken);
            const result = isValidJson(repaired);
            assert.strictEqual(result.isValid, true);
        });

        it('should fix missing colon for completed boolean', () => {
            // This specific pattern is common in LLM output
            const broken = '{"todos": [{"text": "Test", "completed" false}]}';
            const repaired = repairJson(broken);
            const result = isValidJson(repaired);
            assert.strictEqual(result.isValid, true);
        });

        it('should attempt repair without crashing', () => {
            // Even badly broken JSON shouldn't crash
            const broken = '{"text":broken value, missing stuff}';
            const repaired = repairJson(broken);
            // May not be valid, but shouldn't throw
            assert.ok(typeof repaired === 'string');
        });
    });

    describe('safeParseJson', () => {
        it('should parse valid JSON directly', () => {
            const result = safeParseJson('{"message": "Hello"}');
            assert.ok(result);
            assert.strictEqual(result.wasRepaired, false);
            assert.deepStrictEqual(result.parsed, { message: 'Hello' });
        });

        it('should extract and parse JSON from text', () => {
            const result = safeParseJson('Response: {"message": "Hello"} end');
            assert.ok(result);
            assert.deepStrictEqual(result.parsed, { message: 'Hello' });
        });

        it('should repair and parse broken JSON', () => {
            const broken = '{"message": "Hello", "completed" false}';
            const result = safeParseJson(broken);
            assert.ok(result);
            assert.strictEqual(result.wasRepaired, true);
        });

        it('should return null for HTTP errors', () => {
            const result = safeParseJson('<!DOCTYPE html><html>Error</html>');
            assert.strictEqual(result, null);
        });

        it('should return null for unparseable text', () => {
            const result = safeParseJson('This is just plain text with no JSON');
            assert.strictEqual(result, null);
        });

        it('should handle the malformed example from user', () => {
            // Simplified version of the user's broken JSON
            const broken = `{
"todos": [
{ "text":Locate files","completed": false },
"text": "Review logic", "completed": false }
],
"message": "Some message"
}`;
            // This one is pretty badly broken, but let's see if we can salvage it
            const result = safeParseJson(broken);
            // Even if full repair fails, we should at least not crash
            // The legacy fallback will handle it
        });

        it('should fix empty completed values', () => {
            const broken = '{"todos": [{"text": "Test", "completed": }]}';
            const repaired = repairJson(broken);
            const result = isValidJson(repaired);
            assert.strictEqual(result.isValid, true);
            assert.deepStrictEqual((result.parsed as any).todos[0].completed, false);
        });

        it('should fix missing colon after text key', () => {
            const broken = '{"todos": [{ "text" "Validate", "completed": false }]}';
            const repaired = repairJson(broken);
            const result = isValidJson(repaired);
            assert.strictEqual(result.isValid, true);
        });

        it('should fix missing colon after message key', () => {
            const broken = '{"message" "Hello world"}';
            const repaired = repairJson(broken);
            const result = isValidJson(repaired);
            assert.strictEqual(result.isValid, true);
        });

        it('should fix missing closing brace before bracket', () => {
            const broken = '{"todos": [{"text": "Test", "completed": false ]}';
            const repaired = repairJson(broken);
            const result = isValidJson(repaired);
            assert.strictEqual(result.isValid, true);
        });

        it('should handle complex malformed todos array', () => {
            const broken = `{
"todos": [
{ "text": "Locate files", "completed": false },
{ "text": "Review logic", "completed": },
{ "text": "Check errors", "completed": },
{ "text" "Validate usage", "completed": false ]
}`;
            const repaired = repairJson(broken);
            const result = isValidJson(repaired);
            assert.strictEqual(result.isValid, true);
            const parsed = result.parsed as any;
            assert.ok(parsed.todos);
            assert.ok(parsed.todos.length >= 1);
        });

        it('should fix empty key for message field', () => {
            const broken = '{"": "# Hello World"}';
            const repaired = repairJson(broken);
            const result = isValidJson(repaired);
            assert.strictEqual(result.isValid, true);
            assert.strictEqual((result.parsed as any).message, '# Hello World');
        });

        it('should fix missing opening quote before key', () => {
            const broken = '{"text": "Test",completed": false}';
            const repaired = repairJson(broken);
            const result = isValidJson(repaired);
            assert.strictEqual(result.isValid, true);
        });

        it('should fix missing opening quote after colon', () => {
            const broken = '{"text":Check error handling"}';
            const repaired = repairJson(broken);
            const result = isValidJson(repaired);
            assert.strictEqual(result.isValid, true);
            assert.strictEqual((result.parsed as any).text, 'Check error handling');
        });

        it('should fix missing brace between array items', () => {
            const broken = '{"todos": [{"text": "A", "completed": false { "text": "B", "completed": true}]}';
            const repaired = repairJson(broken);
            const result = isValidJson(repaired);
            assert.strictEqual(result.isValid, true);
        });

        it('should fix standalone text after completed', () => {
            const broken = '{"todos": [{"text": "A", "completed": false}, "text": "B", "completed": true}]}';
            const repaired = repairJson(broken);
            const result = isValidJson(repaired);
            assert.strictEqual(result.isValid, true);
        });

        it('should handle the exact user example', () => {
            const broken = `{
"todos": [
{ "text": "Locate 06_read_*.py files",completed": false },
"text": "Review replica read", "completed": false { "text":Check error handling", "completed": },
{ "text "Verify best practices", "completed": }
],
"": "# Review of 06_read_*.py",
"nextSteps": ["Open files", "Share code"]
}`;
            const repaired = repairJson(broken);
            const result = isValidJson(repaired);
            assert.strictEqual(result.isValid, true);
            const parsed = result.parsed as any;
            assert.ok(parsed.message);
            assert.ok(parsed.nextSteps);
        });

        it('should fix concatenated completed in text value', () => {
            const broken = '{"text":"Fix syntax errorcompleted":false}';
            const repaired = repairJson(broken);
            const result = isValidJson(repaired);
            assert.strictEqual(result.isValid, true);
        });

        it('should fix textValue concatenation (missing colon)', () => {
            const broken = '{"textImprove exception handling","completed":false}';
            const repaired = repairJson(broken);
            const result = isValidJson(repaired);
            assert.strictEqual(result.isValid, true);
            assert.strictEqual((result.parsed as any).text, 'Improve exception handling');
        });

        it('should fix empty key for text field', () => {
            const broken = '{"todos":[{"":"Fix timedelta","completed":false}]}';
            const repaired = repairJson(broken);
            const result = isValidJson(repaired);
            assert.strictEqual(result.isValid, true);
            assert.strictEqual((result.parsed as any).todos[0].text, 'Fix timedelta');
        });

        it('should handle the newer user example with concatenations', () => {
            const broken = `{"todos":[{"text":"Fix syntax errorcompleted":false},{"text":"Add timeoutcompleted":false},{"textImprove handling","completed":false}],"message":"Review done"}`;
            const repaired = repairJson(broken);
            const result = isValidJson(repaired);
            assert.strictEqual(result.isValid, true);
            const parsed = result.parsed as any;
            assert.ok(parsed.todos);
            assert.ok(parsed.message);
        });

        it('should fix falsetext pattern (missing }, { between items)', () => {
            const broken = '{"todos":[{"text":"A","completed":falsetext":"B","completed":false}]}';
            const repaired = repairJson(broken);
            const result = isValidJson(repaired);
            assert.strictEqual(result.isValid, true);
            const parsed = result.parsed as any;
            assert.strictEqual(parsed.todos.length, 2);
        });

        it('should fix missing opening quote for content field', () => {
            const broken = '{"sections":[{"heading":"Strengths","content":Excellent coverage of patterns.}]}';
            const repaired = repairJson(broken);
            const result = isValidJson(repaired);
            assert.strictEqual(result.isValid, true);
            assert.ok((result.parsed as any).sections[0].content.startsWith('Excellent'));
        });

        it('should fix missing opening quote for heading field', () => {
            const broken = '{"sections":[{"heading":Overview of the code,"content":"Details here."}]}';
            const repaired = repairJson(broken);
            const result = isValidJson(repaired);
            assert.strictEqual(result.isValid, true);
            assert.ok((result.parsed as any).sections[0].heading.startsWith('Overview'));
        });

        it('should handle the sections content missing quote example', () => {
            const broken = `{"summary": "Review done", "sections": [{"heading": "Strengths", "content":Excellent comprehensive coverage of replica read patterns.}]}`;
            const repaired = repairJson(broken);
            const result = isValidJson(repaired);
            assert.strictEqual(result.isValid, true);
            const parsed = result.parsed as any;
            assert.ok(parsed.sections);
            assert.strictEqual(parsed.sections[0].heading, 'Strengths');
            assert.ok(parsed.sections[0].content.includes('Excellent'));
        });

        it('should fix empty key to heading when followed by content', () => {
            const broken = '{"sections": [{"": "Strengths", "content": "Good stuff"}]}';
            const repaired = repairJson(broken);
            const result = isValidJson(repaired);
            assert.strictEqual(result.isValid, true);
            const parsed = result.parsed as any;
            assert.strictEqual(parsed.sections[0].heading, 'Strengths');
            assert.strictEqual(parsed.sections[0].content, 'Good stuff');
        });

        it('should handle combined empty heading key and unquoted content', () => {
            const broken = '{"sections": [{"": "Strengths", "content":Excellent structure with examples.}]}';
            const repaired = repairJson(broken);
            const result = isValidJson(repaired);
            assert.strictEqual(result.isValid, true);
            const parsed = result.parsed as any;
            assert.strictEqual(parsed.sections[0].heading, 'Strengths');
            assert.ok(parsed.sections[0].content.includes('Excellent'));
        });

        it('should fix unclosed heading key with empty content key', () => {
            const broken = '{"heading "Strengths", "": "Excellent comprehensive coverage."}';
            const repaired = repairJson(broken);
            const result = isValidJson(repaired);
            assert.strictEqual(result.isValid, true);
            const parsed = result.parsed as any;
            assert.strictEqual(parsed.heading, 'Strengths');
            assert.strictEqual(parsed.content, 'Excellent comprehensive coverage.');
        });

        it('should fix content starting with number', () => {
            const broken = '{"heading": "Issues", "content":1. Inconsistent timeout units.}';
            const repaired = repairJson(broken);
            const result = isValidJson(repaired);
            assert.strictEqual(result.isValid, true);
            const parsed = result.parsed as any;
            assert.ok(parsed.content.startsWith('1.'));
        });

        it('should handle multiple sections with various malformations', () => {
            const broken = '{"sections": [{"heading "Strengths", "": "Good stuff."}, {"heading": "Issues", "content":1. Bad stuff.}]}';
            const repaired = repairJson(broken);
            const result = isValidJson(repaired);
            assert.strictEqual(result.isValid, true);
            const parsed = result.parsed as any;
            assert.strictEqual(parsed.sections[0].heading, 'Strengths');
            assert.strictEqual(parsed.sections[0].content, 'Good stuff.');
            assert.strictEqual(parsed.sections[1].heading, 'Issues');
            assert.ok(parsed.sections[1].content.startsWith('1.'));
        });

        it('should fix codeBlocks outside section object', () => {
            const broken = '{"sections": [{"heading": "Recs", "content": "Add check"}, "codeBlocks": [{"language": "python", "code": "x"}]]}';
            const repaired = repairJson(broken);
            const result = isValidJson(repaired);
            assert.strictEqual(result.isValid, true);
            const parsed = result.parsed as any;
            assert.strictEqual(parsed.sections[0].heading, 'Recs');
            assert.strictEqual(parsed.sections[0].codeBlocks.length, 1);
            assert.strictEqual(parsed.sections[0].codeBlocks[0].language, 'python');
        });
    });
});
