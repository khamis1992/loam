export default function App() {
  return (
    <main className="bg-white text-black p-[13px]">
      <h1>Seeded app</h1>
      <Button>Save</Button>
      <Search />
      <Tooltip>
        <TooltipTrigger>Hover</TooltipTrigger>
        <TooltipContent>Tip</TooltipContent>
      </Tooltip>
    </main>
  );
}
