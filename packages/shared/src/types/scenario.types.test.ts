import { describe, it, expectTypeOf } from 'vitest';
import type * as z from 'zod';
import type {
  ScenarioArticle,
  ScenarioCaseTemplate,
  ScenarioCompileOptions,
  ScenarioPack,
  ScenarioTopic,
} from './scenario.types.js';
import type {
  scenarioArticleSchema,
  scenarioCaseTemplateSchema,
  scenarioCompileOptionsSchema,
  scenarioPackSchema,
  scenarioTopicSchema,
} from '../schemas/scenario.schema.js';

/*
 * The interfaces are what the extension and the webview are written
 * against; the schemas are what a file of the workspace and a model's draft
 * are read with. A field one has and the other lacks would be read and never
 * typed, or typed and never read.
 */
describe('scenario types', () => {
  it('are what the pack schema reads, and the other way round', () => {
    expectTypeOf<z.output<typeof scenarioPackSchema>>().toEqualTypeOf<ScenarioPack>();
    expectTypeOf<z.output<typeof scenarioTopicSchema>>().toEqualTypeOf<ScenarioTopic>();
    expectTypeOf<z.output<typeof scenarioArticleSchema>>().toEqualTypeOf<ScenarioArticle>();
    expectTypeOf<
      z.output<typeof scenarioCaseTemplateSchema>
    >().toEqualTypeOf<ScenarioCaseTemplate>();
  });

  it('are what the options schema reads, and the other way round', () => {
    expectTypeOf<
      z.output<typeof scenarioCompileOptionsSchema>
    >().toEqualTypeOf<ScenarioCompileOptions>();
  });
});
