// X1 — rank() latency for 200 items on the **Kotlin track's ranker** (apps/kotlin/.../rank/Rank.kt).
//
// Why Java and not a Kotlin test: the card forbids editing apps/kotlin (owns: bench/ only), so the
// driver lives here and links against the classes the normal Gradle build already produced
// (apps/kotlin/app/build/tmp/kotlin-classes/debug). Kotlin top-level functions compile to
// `RankKt` static methods, so plain javac + the kotlin-stdlib jar is enough — no kotlinc, no Gradle
// change, no source touched. build-kotlin-driver.sh does the two commands; README documents them.
//
// It reads the SAME bench/.cache/rank200.txt fixture as the ts-core and oracle benchmarks, so the
// three numbers describe one workload.
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

import dev.hajnina.scanlist.kotlin.rank.RankCandidate;
import dev.hajnina.scanlist.kotlin.rank.RankEntry;
import dev.hajnina.scanlist.kotlin.rank.RankItem;
import dev.hajnina.scanlist.kotlin.rank.RankQueries;
import dev.hajnina.scanlist.kotlin.rank.RankResult;
import dev.hajnina.scanlist.kotlin.rank.RankState;

public final class Rank200 {
    private static final int ITERATIONS = Integer.parseInt(System.getenv().getOrDefault("X1_ITERATIONS", "300"));
    private static final int WARMUP = Integer.parseInt(System.getenv().getOrDefault("X1_WARMUP", "50"));

    private Rank200() {}

    static double[] parseVec(String csv) {
        String[] parts = csv.split(",");
        double[] out = new double[parts.length];
        for (int i = 0; i < parts.length; i++) out[i] = Double.parseDouble(parts[i]);
        return out;
    }

    static double percentile(double[] sorted, double p) {
        int idx = Math.min(sorted.length - 1, (int) Math.ceil((p / 100.0) * sorted.length) - 1);
        return sorted[Math.max(0, idx)];
    }

    static String statsJson(double[] samples) {        double[] s = samples.clone();
        java.util.Arrays.sort(s);
        double sum = 0;
        for (double v : s) sum += v;
        return String.format(
                Locale.ROOT,
                "{\"n\": %d, \"min\": %.6f, \"p50\": %.6f, \"p95\": %.6f, \"max\": %.6f, \"mean\": %.6f, \"unit\": \"ms\"}",
                s.length, s[0], percentile(s, 50), percentile(s, 95), s[s.length - 1], sum / s.length);
    }

    /** First three non-done entries as `{"id": ..., "smoothed": ...}` — the cross-implementation check. */
    static String top3Json(RankResult out) {
        StringBuilder sb = new StringBuilder();
        int n = 0;
        for (RankEntry e : out.getEntries()) {
            if (e.getDone() || n == 3) continue;
            if (n > 0) sb.append(", ");
            sb.append("{\"id\": \"").append(e.getId()).append("\", \"smoothed\": ")
              .append(String.format(Locale.ROOT, "%.6f", e.getSmoothed() == null ? 0.0 : e.getSmoothed()))
              .append("}");
            n++;
        }
        return sb.toString();
    }

    public static void main(String[] args) throws IOException {
        Path fixture = Path.of(args.length > 0 ? args[0] : "bench/.cache/rank200.txt");
        Path outFile = Path.of(args.length > 1 ? args[1] : "bench/results/fragments/rank-kotlin.json");
        if (!Files.isRegularFile(fixture)) {
            throw new IllegalStateException("missing " + fixture.toAbsolutePath() + " — run: node bench/scripts/make-fixture.mjs");
        }

        List<RankItem> items = new ArrayList<>();
        List<double[]> text = new ArrayList<>();
        List<double[]> image = new ArrayList<>();
        Map<String, String> meta = new LinkedHashMap<>();
        List<String> lines = Files.readAllLines(fixture, StandardCharsets.UTF_8);
        for (String kv : lines.get(0).split("\\s+")) {
            int eq = kv.indexOf('=');
            if (eq > 0) meta.put(kv.substring(0, eq), kv.substring(eq + 1));
        }
        for (String line : lines.subList(1, lines.size())) {
            if (line.isEmpty()) continue;
            String[] p = line.split("\\|", -1);
            switch (p[0]) {
                case "ITEM" -> {
                    String[] aliases = p[5].isEmpty() ? new String[0] : p[5].split(";");
                    items.add(new RankItem(p[1], p[4], List.of(aliases), "1".equals(p[3]), Integer.parseInt(p[2]), parseVec(p[6])));
                }
                case "TEXT" -> text.add(parseVec(p[1]));
                case "IMAGE" -> image.add(parseVec(p[1]));
                default -> throw new IllegalStateException("bad fixture line: " + p[0]);
            }
        }
        RankQueries queries = new RankQueries(text, image);

        long t0 = System.nanoTime();
        RankResult first = dev.hajnina.scanlist.kotlin.rank.RankKt.rank(items, queries, null, null, null, 256);
        double coldMs = (System.nanoTime() - t0) / 1e6;

        RankState state = first.getState();
        for (int i = 0; i < WARMUP; i++) {
            state = dev.hajnina.scanlist.kotlin.rank.RankKt.rank(items, queries, state, null, null, 256).getState();
        }

        double[] rankSamples = new double[ITERATIONS];
        double[] decideSamples = new double[ITERATIONS];
        RankResult out = first;
        for (int i = 0; i < ITERATIONS; i++) {
            t0 = System.nanoTime();
            out = dev.hajnina.scanlist.kotlin.rank.RankKt.rank(items, queries, state, null, null, 256);
            rankSamples[i] = (System.nanoTime() - t0) / 1e6;
            state = out.getState();

            List<RankCandidate> candidates = new ArrayList<>();
            for (RankEntry e : out.getEntries()) {
                if (e.getDone()) continue;
                candidates.add(new RankCandidate(e.getId(), candidates.size(), e.getRaw() == null ? 0.0 : e.getRaw(), e.getSmoothed() == null ? 0.0 : e.getSmoothed()));
            }
            t0 = System.nanoTime();
            dev.hajnina.scanlist.kotlin.rank.RankKt.decideTop(candidates, state.getTopId());
            decideSamples[i] = (System.nanoTime() - t0) / 1e6;
        }

        String json = "{\n"
                + "  \"generatedAt\": \"" + java.time.Instant.now() + "\",\n"
                + "  \"implementation\": \"apps/kotlin rank (Kotlin/JVM port of RANK.md, scalar float64 loops)\",\n"
                + "  \"provenance\": {\n"
                + "    \"source\": \"apps/kotlin/app/src/main/java/dev/hajnina/scanlist/kotlin/rank/Rank.kt\",\n"
                + "    \"classes\": \"apps/kotlin/app/build/tmp/kotlin-classes/debug (from ./gradlew :scanlistKotlin:assembleDebug)\",\n"
                + "    \"fixture\": \"bench/.cache/rank200.txt (generated by bench/scripts/make-fixture.mjs)\",\n"
                + "    \"runner\": \"java " + System.getProperty("java.version") + " (JVM desktop, not ART on a phone)\",\n"
                + "    \"caveat\": \"JVM desktop timings; the app runs the same code on ART, which is slower — treat this as a lower bound for on-device rank time\"\n"
                + "  },\n"
                + "  \"environment\": {\"jvm\": \"" + System.getProperty("java.version") + "\", \"iterations\": " + ITERATIONS
                + ", \"warmup\": " + WARMUP + ", \"items\": " + items.size() + ", \"dims\": " + meta.get("dims") + "},\n"
                + "  \"measurements\": {\n"
                + "    \"rank200\": " + statsJson(rankSamples) + ",\n"
                + "    \"decideTop200\": " + statsJson(decideSamples) + ",\n"
                + "    \"rank200.coldFirstTick\": {\"status\": \"measured\", \"ms\": " + String.format(Locale.ROOT, "%.6f", coldMs) + "}\n"
                + "  },\n"
                // Cross-implementation sanity: ts-core / Kotlin / oracle must agree on the hero id for
                // this workload, otherwise the three latency numbers would not describe the same work.
                + "  \"sanity\": {\"topId\": " + (state.getTopId() == null ? "null" : "\"" + state.getTopId() + "\"")
                + ", \"entries\": " + out.getEntries().size()
                + ", \"top3\": [" + top3Json(out) + "]}\n"
                + "}\n";
        Files.createDirectories(outFile.getParent());
        Files.writeString(outFile, json, StandardCharsets.UTF_8);

        double[] sorted = rankSamples.clone();
        java.util.Arrays.sort(sorted);
        double[] decideSorted = decideSamples.clone();
        java.util.Arrays.sort(decideSorted);
        System.out.printf(
                Locale.ROOT,
                "kotlin rank(200 items, 16 text + 1 image queries): p50 %.3f ms, p95 %.3f ms (min %.3f, max %.3f, n=%d); decideTop p95 %.4f ms%n",
                percentile(sorted, 50), percentile(sorted, 95), sorted[0], sorted[sorted.length - 1], sorted.length,
                percentile(decideSorted, 95));
        System.out.println("-> " + outFile);
    }
}
