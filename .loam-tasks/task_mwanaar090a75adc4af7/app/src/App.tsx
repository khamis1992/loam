import { useState } from "react";
import { Activity, ArrowRight, BarChart3, Rocket, ShieldCheck, Sparkles, Zap } from "lucide-react";
import { useTheme } from "./components/theme-provider";
import { LanguageToggle } from "./components/language-toggle";
import { ModeToggle } from "./components/mode-toggle";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "./components/ui/accordion";
import { Alert, AlertDescription, AlertTitle } from "./components/ui/alert";
import { Avatar, AvatarFallback } from "./components/ui/avatar";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "./components/ui/card";
import { Checkbox } from "./components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "./components/ui/dialog";
import { Input } from "./components/ui/input";
import { Label } from "./components/ui/label";
import { Progress } from "./components/ui/progress";
import { RadioGroup, RadioGroupItem } from "./components/ui/radio-group";
import { Select } from "./components/ui/select";
import { Separator } from "./components/ui/separator";
import { Slider } from "./components/ui/slider";
import { Switch } from "./components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./components/ui/tabs";
import { Textarea } from "./components/ui/textarea";
import { Tooltip } from "./components/ui/tooltip";
import { formatNumber } from "./lib/utils";

const plans = [
  { value: "starter", label: "Starter — free" },
  { value: "growth", label: "Growth — $24/mo" },
  { value: "scale", label: "Scale — $99/mo" },
];

const usageRows = [
  { name: "Ingestion", used: 72, unit: "GB", cost: "$18.40" },
  { name: "Queries", used: 41, unit: "k", cost: "$12.10" },
  { name: "Exports", used: 88, unit: "k", cost: "$9.75" },
];

function Header() {
  const { lang } = useTheme();
  return (
    <header className="sticky top-0 z-40 border-b bg-background/80 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-5xl items-center gap-3 px-4">
        <a href="#top" className="flex items-center gap-2 font-semibold">
          <span className="grid size-7 place-items-center rounded-md bg-primary text-primary-foreground">
            <Sparkles className="size-4" />
          </span>
          Northstar
        </a>
        <Badge variant="secondary" className="ms-1">{lang === "ar" ? "تجريبي" : "Beta"}</Badge>
        <nav className="ms-auto hidden items-center gap-1 text-sm text-muted-foreground md:flex">
          <a className="rounded-md px-3 py-1.5 hover:bg-accent hover:text-accent-foreground" href="#features">Features</a>
          <a className="rounded-md px-3 py-1.5 hover:bg-accent hover:text-accent-foreground" href="#usage">Usage</a>
          <a className="rounded-md px-3 py-1.5 hover:bg-accent hover:text-accent-foreground" href="#faq">FAQ</a>
        </nav>
        <div className="ms-auto flex items-center gap-2 md:ms-2">
          <LanguageToggle />
          <ModeToggle />
          <Button size="sm" className="hidden sm:inline-flex">Get started</Button>
        </div>
      </div>
    </header>
  );
}

function Hero() {
  return (
    <section id="top" className="mx-auto max-w-5xl px-4 py-16 sm:py-20">
      <Badge className="mb-4">New · Realtime insights</Badge>
      <h1 className="max-w-2xl text-4xl font-semibold tracking-tight sm:text-5xl">
        Understand your product in minutes, not meetings
      </h1>
      <p className="mt-4 max-w-xl text-base leading-relaxed text-muted-foreground sm:text-lg">
        Northstar turns raw events into clear answers. Connect a source, pick a question, and read the result — no SQL required.
      </p>
      <div className="mt-8 flex flex-wrap items-center gap-3">
        <Tooltip label="No credit card required">
          <Button size="lg">
            Start free <ArrowRight className="size-4" />
          </Button>
        </Tooltip>
        <Button size="lg" variant="outline">
          Read the docs
        </Button>
      </div>
      <div className="mt-10 flex flex-wrap gap-6 text-sm text-muted-foreground">
        <span className="flex items-center gap-2"><ShieldCheck className="size-4 text-primary" /> SOC 2 Type II</span>
        <span className="flex items-center gap-2"><Zap className="size-4 text-primary" /> 3-minute setup</span>
        <span className="flex items-center gap-2"><Activity className="size-4 text-primary" /> 99.99% uptime</span>
      </div>
    </section>
  );
}

function Features() {
  const features = [
    { icon: Zap, title: "Instant answers", body: "Ask a question in plain language and get a chart, not a spreadsheet." },
    { icon: BarChart3, title: "Live dashboards", body: "Boards refresh as events arrive, so the numbers never go stale." },
    { icon: ShieldCheck, title: "Private by default", body: "Row-level access, audit logs and regional storage built in." },
  ];
  return (
    <section id="features" className="mx-auto max-w-5xl px-4 py-12">
      <div className="grid gap-4 sm:grid-cols-3">
        {features.map((feature) => (
          <Card key={feature.title}>
            <CardHeader>
              <span className="mb-1 grid size-9 place-items-center rounded-md bg-primary/10 text-primary">
                <feature.icon className="size-4" />
              </span>
              <CardTitle className="text-base">{feature.title}</CardTitle>
              <CardDescription>{feature.body}</CardDescription>
            </CardHeader>
          </Card>
        ))}
      </div>
    </section>
  );
}

function Usage() {
  const { direction } = useTheme();
  return (
    <section id="usage" className="mx-auto max-w-5xl px-4 py-12">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">This month</h2>
          <p className="mt-1 text-sm text-muted-foreground">Usage resets on the first day of each month.</p>
        </div>
        <Badge variant="outline">{direction === "rtl" ? "مخطط" : "Chart"}</Badge>
      </div>
      <div className="mt-6 grid gap-4 sm:grid-cols-3">
        {usageRows.map((row) => (
          <Card key={row.name}>
            <CardHeader>
              <CardDescription>{row.name}</CardDescription>
              <CardTitle className="text-2xl">
                {formatNumber(row.used)}
                <span className="ms-1 text-sm font-normal text-muted-foreground">{row.unit}</span>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <Progress value={row.used} />
              <p className="mt-2 text-xs text-muted-foreground">{row.cost} estimated</p>
            </CardContent>
          </Card>
        ))}
      </div>
      <Card className="mt-4">
        <CardHeader>
          <CardTitle className="text-base">Top sources</CardTitle>
          <CardDescription>Where your events came from.</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Source</TableHead>
                <TableHead>Events</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow>
                <TableCell className="font-medium">Web app</TableCell>
                <TableCell>128,402</TableCell>
                <TableCell><Badge variant="secondary">Healthy</Badge></TableCell>
              </TableRow>
              <TableRow>
                <TableCell className="font-medium">Mobile SDK</TableCell>
                <TableCell>84,119</TableCell>
                <TableCell><Badge variant="secondary">Healthy</Badge></TableCell>
              </TableRow>
              <TableRow>
                <TableCell className="font-medium">Partner API</TableCell>
                <TableCell>9,204</TableCell>
                <TableCell><Badge variant="destructive">Degraded</Badge></TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </section>
  );
}

function SettingsForm() {
  const [plan, setPlan] = useState("growth");
  const [team, setTeam] = useState(true);
  const [threshold, setThreshold] = useState(65);
  const [channel, setChannel] = useState("email");
  const [notify, setNotify] = useState(true);
  const [summary, setSummary] = useState("");

  return (
    <Card className="mx-auto max-w-5xl">
      <CardHeader>
        <CardTitle className="text-base">Workspace settings</CardTitle>
        <CardDescription>Changes apply to everyone on this workspace.</CardDescription>
      </CardHeader>
      <CardContent>
        <Tabs defaultValue="general">
          <TabsList>
            <TabsTrigger value="general">General</TabsTrigger>
            <TabsTrigger value="alerts">Alerts</TabsTrigger>
          </TabsList>
          <TabsContent value="general" className="mt-4 grid gap-5 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="workspace">Workspace name</Label>
              <Input id="workspace" defaultValue="Northstar" />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="plan">Plan</Label>
              <Select id="plan" value={plan} onValueChange={setPlan} options={plans} />
            </div>
            <div className="grid gap-2 sm:col-span-2">
              <Label htmlFor="summary">Summary</Label>
              <Textarea id="summary" value={summary} onChange={(event) => setSummary(event.target.value)} placeholder="What does this workspace track?" />
            </div>
            <label className="flex items-center gap-2 text-sm font-medium">
              <Checkbox checked={team} onCheckedChange={(value) => setTeam(value === true)} id="team" />
              Invite the whole team
            </label>
            <label className="flex items-center gap-2 text-sm font-medium">
              <Switch checked={notify} onCheckedChange={setNotify} id="notify" />
              Weekly email digest
            </label>
          </TabsContent>
          <TabsContent value="alerts" className="mt-4 grid gap-5">
            <div className="grid gap-2">
              <Label>Alert channel</Label>
              <RadioGroup value={channel} onValueChange={setChannel} className="flex flex-wrap gap-4 pt-1">
                <label className="flex items-center gap-2 text-sm">
                  <RadioGroupItem value="email" id="email" />
                  Email
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <RadioGroupItem value="slack" id="slack" />
                  Slack
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <RadioGroupItem value="webhook" id="webhook" />
                  Webhook
                </label>
              </RadioGroup>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="threshold">Notify above {threshold}% usage</Label>
              <Slider id="threshold" value={threshold} onValueChange={setThreshold} min={10} max={100} step={5} />
            </div>
          </TabsContent>
        </Tabs>
      </CardContent>
      <CardFooter className="justify-between">
        <p className="text-xs text-muted-foreground">Saved automatically.</p>
        <Button type="button">Save changes</Button>
      </CardFooter>
    </Card>
  );
}

function Faq() {
  const items = [
    { q: "Do I need to know SQL?", a: "No. Ask in plain language, or drop a CSV and we will chart it for you." },
    { q: "Can I self-host?", a: "Yes. The same features ship as a container you can run inside your own network." },
    { q: "How is my data handled?", a: "Events are encrypted in transit and at rest, and you can export or delete them at any time." },
  ];
  return (
    <section id="faq" className="mx-auto max-w-5xl px-4 py-12">
      <h2 className="text-2xl font-semibold tracking-tight">Frequently asked</h2>
      <Accordion type="single" defaultValue={items[0]!.q} className="mt-6">
        {items.map((item) => (
          <AccordionItem key={item.q} value={item.q}>
            <AccordionTrigger>{item.q}</AccordionTrigger>
            <AccordionContent>{item.a}</AccordionContent>
          </AccordionItem>
        ))}
      </Accordion>
    </section>
  );
}

function ConfirmDialog() {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="outline">Delete workspace</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete this workspace?</DialogTitle>
          <DialogDescription>
            This removes every event, board and alert. The action cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" type="button">Cancel</Button>
          <Button variant="destructive" type="button">Delete</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function App() {
  return (
    <div className="min-h-dvh bg-background text-foreground">
      <Header />
      <main>
        <Hero />
        <Features />
        <Usage />
        <div className="mx-auto max-w-5xl px-4 pb-12">
          <Alert variant="success" className="mb-6">
            <AlertTitle>All systems operational</AlertTitle>
            <AlertDescription>Ingestion is healthy across every region.</AlertDescription>
          </Alert>
          <SettingsForm />
          <div className="mt-6 flex justify-center">
            <ConfirmDialog />
          </div>
        </div>
        <Faq />
      </main>
      <footer className="border-t">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-3 px-4 py-8 text-sm text-muted-foreground">
          <span className="flex items-center gap-2">
            <Rocket className="size-4" /> Northstar Labs
          </span>
          <Separator orientation="vertical" className="hidden h-4 sm:block" />
          <span>Built with the Loam UI Kit</span>
          <span className="ms-auto flex items-center gap-2">
            <Avatar className="size-6">
              <AvatarFallback>NL</AvatarFallback>
            </Avatar>
            <span>Team workspace</span>
          </span>
        </div>
      </footer>
    </div>
  );
}
