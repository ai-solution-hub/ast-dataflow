// Fixture: hand-rolled query builder — the .from() return type is an inferred
// structural object literal (`{ select(...): ... }`), not a Supabase generic
// instantiation. The old heuristic's branch 1-b claimed typed for any
// structural return-type text containing `{`.
// Expected column-reads hits for table='bid_questions', column='project_id':
//   Line 27 — .select('project_id')            method='select'  isTyped=false  confidence='indirect'
//   Line 27 — .eq('project_id', procurementId) method='eq'      isTyped=false  confidence='indirect'
function makeDb() {
  return {
    from(_table: string) {
      return {
        select(_cols: string) {
          return {
            eq(_column: string, _value: string) {
              return Promise.resolve({ data: null, error: null });
            },
          };
        },
      };
    },
  };
}

const db = makeDb();

async function fetchStructural(procurementId: string) {
  return db
    .from('bid_questions')
    .select('project_id')
    .eq('project_id', procurementId);
}

export { fetchStructural };
