import { CsvSource, type FactsSource } from './source.ts';
import { ZetarisSource } from './zetaris.ts';

// Data mode is independent of model mode: recorded samples can use the live Zetaris data layer.
export function configuredSource():FactsSource{
  const mode=process.env.FACTS_SOURCE??(process.env.ZETARIS_BRIDGE_URL?'zetaris':'csv');
  if(mode==='csv')return new CsvSource();
  if(mode==='zetaris')return new ZetarisSource();
  throw new Error('FACTS_SOURCE must be csv or zetaris');
}
