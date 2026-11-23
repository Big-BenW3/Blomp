// Shows the title at once while the repo list loads. No spinner on purpose: the list simply appears.
export default function Loading() {
  return (
    <main className="flex flex-col gap-3.5">
      <h1 className="ui-title">Repos</h1>
    </main>
  );
}
