#!/usr/bin/env -S scala shebang

//> using scala "3.9.0"
//> using dep "com.monovore::decline:2.6.2"
//> using dep "com.fasterxml.jackson.core:jackson-databind:2.22.3"
//> using dep "com.fasterxml.jackson.dataformat:jackson-dataformat-toml:2.22.3"
//> using options "-nowarn"

/** Switches the Codex configuration between presets.
  *
  * The script merges `config.common.json` and the selected preset from
  * `config.presets.json` into the root `config.toml`, then rewrites the model
  * settings of every file in `agents/`. The configuration directory is
  * `CODEX_HOME` when set, and the current working directory otherwise.
  */

import java.nio.ByteBuffer
import java.nio.channels.FileChannel
import java.nio.charset.CodingErrorAction
import java.nio.charset.StandardCharsets.UTF_8
import java.nio.file.*
import java.nio.file.attribute.PosixFilePermission
import scala.jdk.CollectionConverters.*
import scala.util.Try
import com.fasterxml.jackson.core.json.JsonReadFeature
import com.fasterxml.jackson.databind.json.JsonMapper
import com.fasterxml.jackson.databind.{JsonNode, ObjectMapper}
import com.fasterxml.jackson.databind.node.{ArrayNode, NullNode, ObjectNode, TextNode}
import com.fasterxml.jackson.dataformat.toml.TomlMapper
import com.monovore.decline.{Command, Help, Opts}

// Files the script reads and writes, relative to the configuration directory.
val PresetsFile = "config.presets.json"
val CommonFile = "config.common.json"
val RootConfigFile = "config.toml"
val AgentsDir = "agents"

// Root TOML keys that select a model.
val ModelKey = "model"
val EffortKey = "model_reasoning_effort"
val ModelKeys = List(ModelKey, EffortKey)
val AgentsKey = "agents"

/** Parses JSONC: JSON with C-style line and block comments and trailing commas. */
val jsonc: ObjectMapper = JsonMapper.builder()
  .enable(JsonReadFeature.ALLOW_JAVA_COMMENTS)
  .enable(JsonReadFeature.ALLOW_TRAILING_COMMA)
  .build()

/** Reads and writes TOML. */
val toml: ObjectMapper = new TomlMapper()

/** Runs `body`, reporting a failure as `<label>: <cause>`. */
def attempt[A](label: String, body: => A): Either[String, A] =
  Try(body).toEither.left.map(error => s"$label: ${error.getMessage}")

/** Applies `f` to every value, failing with the first error. */
extension [A](values: List[A])
  def traverse[E, B](f: A => Either[E, B]): Either[E, List[B]] =
    values.foldLeft(Right(Nil): Either[E, List[B]]) { (result, value) =>
      for
        results <- result
        applied <- f(value)
      yield applied :: results
    }.map(_.reverse)

/** Reasoning efforts accepted by Codex. */
enum Effort(val value: String):
  case None    extends Effort("none")
  case Minimal extends Effort("minimal")
  case Low     extends Effort("low")
  case Medium  extends Effort("medium")
  case High    extends Effort("high")
  case XHigh   extends Effort("xhigh")

object Effort:
  private val byValue = Effort.values.map(effort => effort.value -> effort).toMap
  def fromValue(value: String): Option[Effort] = byValue.get(value)

/** The agent roster, in report order; case names select each agent's file in `agents/`. */
enum Agent:
  case Orchestrator, Solo, Junior, Explorer, Librarian

object Agent:
  private val byName = Agent.values.map(agent => agent.toString -> agent).toMap
  def fromName(name: String): Option[Agent] = byName.get(name)

/** The model and reasoning effort assigned to the root configuration or an agent. */
final case class ModelSettings(model: String, effort: Effort):
  /** TOML assignment lines that replace the model settings at the top of a file. */
  def assignments: String =
    s"$ModelKey = ${tomlString(model)}\n$EffortKey = ${tomlString(effort.value)}\n"

/** A validated preset: root model settings, plus settings for every agent. */
final case class Preset(root: ModelSettings, agents: Vector[(Agent, ModelSettings)]):
  /** The root TOML overlay, carrying only the model settings. */
  def rootOverlay: ObjectNode = jsonc.createObjectNode()
    .put(ModelKey, root.model)
    .put(EffortKey, root.effort.value)

/** The root config.toml captured before any writes; `raw` is empty when it does not exist. */
final case class RootSnapshot(raw: Option[Array[Byte]], tree: JsonNode)

/** One row of the applied table: the configuration file, its model, and its effort. */
final case class Applied(configuration: String, model: String, effort: String)

/** A fully prepared agent configuration write. */
final case class AgentWrite(path: Path, contents: String)

/** Reads a file as bytes, treating a missing file as an empty result. */
def readOptionalBytes(path: Path): Either[String, Option[Array[Byte]]] =
  if !Files.exists(path) then Right(None)
  else attempt(s"failed to read $path", Some(Files.readAllBytes(path)))

/** Reads a UTF-8 text file. */
def readFile(path: Path): Either[String, String] =
  attempt(s"failed to read $path", Files.readString(path, UTF_8))

/** Decodes bytes as UTF-8, rejecting malformed input. */
def decodeUtf8(bytes: Array[Byte], label: String): Either[String, String] =
  attempt(s"$label is not valid UTF-8", {
    val decoder = UTF_8.newDecoder()
      .onMalformedInput(CodingErrorAction.REPORT)
      .onUnmappableCharacter(CodingErrorAction.REPORT)
    decoder.decode(ByteBuffer.wrap(bytes)).toString
  })

/** Reads a JSONC file and requires its root value to be an object. */
def readJsonObject(path: Path, label: String): Either[String, ObjectNode] =
  for
    bytes  <- readOptionalBytes(path).flatMap(_.toRight(s"configuration file missing: $path"))
    source <- decodeUtf8(bytes, path.toString)
    parsed <- attempt(s"failed to parse $label", jsonc.readTree(source))
    objectNode <- parsed match
      case objectNode: ObjectNode => Right(objectNode)
      case _ => Left(s"$label must contain a JSON object")
  yield objectNode

/** Parses TOML text into a JSON tree. */
def parseToml(text: String, label: String): Either[String, JsonNode] =
  attempt(s"failed to parse $label", toml.readTree(text))

/** Captures the optional root config.toml that existing local settings come from. */
def readRootSnapshot(path: Path): Either[String, RootSnapshot] =
  for
    raw  <- readOptionalBytes(path)
    tree <- raw match
      case None        => Right(jsonc.createObjectNode(): JsonNode)
      case Some(bytes) =>
        for
          source <- decodeUtf8(bytes, path.toString)
          tree   <- parseToml(source, path.toString)
        yield tree
  yield RootSnapshot(raw, tree)

/** Recursively merges `overlay` into `base`, replacing anything that is not an object pair. */
def deepMerge(base: JsonNode, overlay: JsonNode): JsonNode = (base, overlay) match
  case (baseObj: ObjectNode, overlayObj: ObjectNode) =>
    val merged = baseObj.deepCopy()
    overlayObj.properties.asScala.foreach { entry =>
      merged.set(entry.getKey, deepMerge(baseObj.get(entry.getKey), entry.getValue))
    }
    // The JsonNode type makes the fallback's deepCopy infer JsonNode, not ObjectNode.
    merged: JsonNode
  case _ => overlay.deepCopy()

/** Finds the first JSON null and reports its path. */
def firstNull(node: JsonNode, path: String): Option[String] = node match
  case _: NullNode => Some(s"$path must not contain null")
  case array: ArrayNode =>
    array.asScala.iterator.zipWithIndex
      .flatMap((item, index) => firstNull(item, s"$path[$index]"))
      .nextOption()
  case obj: ObjectNode =>
    obj.properties.asScala.iterator
      .flatMap(entry => firstNull(entry.getValue, s"$path.${entry.getKey}"))
      .nextOption()
  case _ => None

/** The message reported when settings do not define a usable model. */
def mustDefine(label: String): String =
  s"$label must define a model and valid model_reasoning_effort"

/** The string value of an object key, when present and textual. */
def text(obj: ObjectNode, key: String): Option[String] =
  obj.get(key) match
    case value: TextNode => Some(value.asText())
    case _ => None

/** Validates the model settings that a preset or agent entry defines. */
def modelSettings(obj: ObjectNode, label: String): Either[String, ModelSettings] =
  (text(obj, ModelKey), text(obj, EffortKey)) match
    case (Some(model), Some(effort)) if model.trim.nonEmpty =>
      Effort.fromValue(effort).map(ModelSettings(model, _)).toRight(mustDefine(label))
    case _ =>
      Left(mustDefine(label))

/** Rejects object keys outside `known`, reporting the first offender. */
def rejectUnknownKeys(obj: ObjectNode, known: Set[String], error: String => String): Either[String, Unit] =
  obj.properties.asScala.map(_.getKey).find(key => !known.contains(key)) match
    case Some(key) => Left(error(key))
    case None      => Right(())

/** Rejects agent entries outside the roster. */
def rejectUnknownAgents(agents: ObjectNode): Either[String, Unit] =
  agents.properties.asScala.map(_.getKey).find(name => Agent.fromName(name).isEmpty) match
    case Some(name) => Left(s"Unknown agent: $name")
    case None       => Right(())

/** Validates a preset and extracts the settings it applies. */
def validatePreset(name: String, preset: JsonNode): Either[String, Preset] =
  preset match
    case presetObj: ObjectNode =>
      for
        root <- modelSettings(presetObj, name)
        _ <- rejectUnknownKeys(presetObj, Set(ModelKey, EffortKey, AgentsKey), key => s"Unknown preset setting: $key")
        agents <- presetObj.get(AgentsKey) match
          case agents: ObjectNode => Right(agents)
          case _ => Left(s"$name must define agents")
        _ <- rejectUnknownAgents(agents)
        agentSettings <- Agent.values.toList.traverse { agent =>
          agents.get(agent.toString) match
            case agentObj: ObjectNode =>
              for
                settings <- modelSettings(agentObj, agent.toString)
                _ <- rejectUnknownKeys(agentObj, ModelKeys.toSet, key => s"Unknown setting for $agent: $key")
              yield (agent, settings)
            case _ => Left(mustDefine(agent.toString))
        }
      yield Preset(root, agentSettings.toVector)
    case _ =>
      Left(mustDefine(name))

/** Renders a string as a TOML basic string; JSON escaping is a valid subset of TOML's. */
def tomlString(value: String): String = TextNode(value).toString

/** Serializes the merged root configuration and verifies that it round-trips through TOML. */
def serializeRoot(config: JsonNode): Either[String, String] =
  for
    contents <- attempt("failed to serialize generated config.toml", toml.writeValueAsString(config))
    roundTripped <- parseToml(contents, "generated config.toml")
    _ <- if roundTripped == config then Right(()) else Left("generated config.toml did not round-trip through TOML")
  yield contents

/** Reports whether a line assigns one of the model keys. */
def isModelAssignment(line: String): Boolean =
  ModelKeys.exists(key => line.startsWith(key) && line.drop(key.length).trim.startsWith("="))

/** Removes the lines that assign one of the model keys. */
def withoutModelAssignments(source: String): String =
  source.split("\n", -1).filterNot(isModelAssignment).mkString("\n")

/** Rewrites an agent TOML document with new model settings.
  *
  * Ordinary single-line model assignments are replaced at the top of the file
  * so comments and prompts stay untouched. Unusual layouts fall back to TOML
  * serialization, which drops comments, so the result must first pass a
  * semantic round-trip check.
  */
def updateAgentToml(source: String, settings: ModelSettings): Either[String, String] =
  for
    parsed <- parseToml(source, "agent configuration")
    expected <- parsed match
      case obj: ObjectNode =>
        val expected = obj.deepCopy()
        expected.put(ModelKey, settings.model)
        expected.put(EffortKey, settings.effort.value)
        Right(expected)
      case _ => Left("agent configuration must be a TOML table")
    updated = settings.assignments + withoutModelAssignments(source)
    result <- parseToml(updated, "rewritten agent configuration").toOption.filter(_ == expected) match
      case Some(_) => Right(updated)
      case None    => attempt("failed to serialize agent configuration", toml.writeValueAsString(expected))
  yield result

/** Writes text to a file. */
def writeFile(path: Path, contents: String): Either[String, Unit] =
  attempt(s"failed to write $path", Files.write(path, contents.getBytes(UTF_8))).map(_ => ())

/** Computes every agent file write before any file is changed. */
def prepareAgentWrites(configDir: Path, preset: Preset): Either[String, List[AgentWrite]] =
  preset.agents.toList.traverse { (agent, settings) =>
    val path = configDir.resolve(AgentsDir).resolve(s"$agent.toml")
    for
      source   <- readFile(path)
      contents <- updateAgentToml(source, settings).left.map(error => s"failed to update $path: $error")
    yield AgentWrite(path, contents)
  }

/** Writes every prepared agent configuration. */
def writeAgentWrites(writes: List[AgentWrite]): Either[String, Unit] =
  writes.traverse(write => writeFile(write.path, write.contents)).map(_ => ())

/** The permissions the root file had before the switch; `None` when it did not exist. */
def existingPermissions(
    destination: Path,
    snapshot: RootSnapshot
): Either[String, Option[java.util.Set[PosixFilePermission]]] =
  if snapshot.raw.isEmpty then Right(None)
  else attempt(s"failed to stat $destination", Option(Files.getPosixFilePermissions(destination)))

/** Creates an exclusively owned temporary file next to the root config.toml. */
def createTempFile(configDir: Path): Either[String, Path] =
  attempt(
    s"failed to create a temporary config.toml file in $configDir",
    Files.createTempFile(configDir, ".config.toml.", ".tmp")
  )

/** Writes and flushes the temporary file, applying the previous permissions when given. */
def writeTempFile(
    temp: Path,
    contents: String,
    perms: Option[java.util.Set[PosixFilePermission]]
): Either[String, Unit] =
  attempt(s"failed to write $temp", {
    val channel = FileChannel.open(temp, StandardOpenOption.WRITE)
    try
      channel.write(ByteBuffer.wrap(contents.getBytes(UTF_8)))
      channel.force(true)
    finally channel.close()
    perms.foreach(permissions => Files.setPosixFilePermissions(temp, permissions))
  })

/** Moves the temporary file onto the root config.toml. */
def moveTemp(temp: Path, destination: Path): Either[String, Unit] =
  attempt(
    s"failed to replace $destination",
    Files.move(temp, destination, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE)
  ).map(_ => ())

/** Compares optional byte arrays by content. */
def sameBytes(left: Option[Array[Byte]], right: Option[Array[Byte]]): Boolean =
  (left, right) match
    case (Some(left), Some(right)) => left.sameElements(right)
    case (None, None)             => true
    case _                        => false

/** Fails when the root config.toml no longer matches the captured snapshot. */
def assertUnchanged(destination: Path, snapshot: RootSnapshot): Either[String, Unit] =
  for
    current <- readOptionalBytes(destination)
    _ <- if sameBytes(current, snapshot.raw) then Right(())
         else Left("config.toml changed while preparing configuration; no files written")
  yield ()

/** Publishes the temporary file, deleting it when publishing fails. */
def publish(
    temp: Path,
    destination: Path,
    contents: String,
    perms: Option[java.util.Set[PosixFilePermission]],
    snapshot: RootSnapshot
): Either[String, Unit] =
  val outcome =
    for
      _ <- writeTempFile(temp, contents, perms)
      _ <- assertUnchanged(destination, snapshot)
      _ <- moveTemp(temp, destination)
    yield ()
  if outcome.isLeft then Try(Files.deleteIfExists(temp))
  outcome

/** Replaces the root config.toml atomically after re-checking for concurrent changes. */
def replaceRootConfig(configDir: Path, snapshot: RootSnapshot, contents: String): Either[String, Unit] =
  val destination = configDir.resolve(RootConfigFile)
  for
    perms <- existingPermissions(destination, snapshot)
    _     <- assertUnchanged(destination, snapshot)
    temp  <- createTempFile(configDir)
    _     <- publish(temp, destination, contents, perms, snapshot)
  yield ()

/** The applied configuration files and their settings, in report order. */
def appliedRows(preset: Preset): Vector[Applied] =
  Applied(RootConfigFile, preset.root.model, preset.root.effort.value) +:
    preset.agents.map((agent, settings) => Applied(s"$AgentsDir/$agent.toml", settings.model, settings.effort.value))

/** Prints the applied configuration files with their model and reasoning effort. */
def printAppliedTable(rows: Vector[Applied]): Unit =
  val configurationWidth = math.max("configuration".length, rows.map(_.configuration.length).max)
  val modelWidth = math.max("model".length, rows.map(_.model.length).max)
  def pad(value: String, width: Int) = value + " " * (width - value.length)
  println()
  println(s"  ${pad("configuration", configurationWidth)} │ ${pad("model", modelWidth)} │ effort")
  println(s"  ${"─" * configurationWidth}─┼─${"─" * modelWidth}─┼─${"─" * "effort".length}")
  rows.foreach { row =>
    println(s"  ${pad(row.configuration, configurationWidth)} │ ${pad(row.model, modelWidth)} │ ${row.effort}")
  }
  println()

/** Lists the available presets, in file order. */
def listPresets(configDir: Path): Either[String, Unit] =
  readJsonObject(configDir.resolve(PresetsFile), PresetsFile).map { presets =>
    println("Usage: codex-switch <preset>\n")
    println("Available presets:")
    presets.properties.asScala.foreach(entry => println(s"  ${entry.getKey}"))
  }

/** Applies the selected preset to the root and agent configuration files. */
def applyPreset(configDir: Path, name: String): Either[String, Unit] =
  for
    presets  <- readJsonObject(configDir.resolve(PresetsFile), PresetsFile)
    preset   <- Option(presets.get(name)).toRight(s"Unknown preset: $name")
    common   <- readJsonObject(configDir.resolve(CommonFile), CommonFile)
    _        <- firstNull(common, CommonFile).toLeft(())
    snapshot <- readRootSnapshot(configDir.resolve(RootConfigFile))
    validated <- validatePreset(name, preset)
    merged    = deepMerge(deepMerge(snapshot.tree, common), validated.rootOverlay)
    _        <- firstNull(merged, RootConfigFile).toLeft(())
    contents  <- serializeRoot(merged)
    agentWrites <- prepareAgentWrites(configDir, validated)
    _        <- replaceRootConfig(configDir, snapshot, contents)
    _        <- writeAgentWrites(agentWrites)
  yield
    println(s"Applied preset: $name")
    printAppliedTable(appliedRows(validated))

/** Reports a fatal error on stderr and exits with status 1. */
def fail(error: String): Nothing =
  System.err.println(s"codex-switch: $error")
  sys.exit(1)

/** Runs an action, reporting its error and exiting if it fails. */
def exitOnFailure(action: Either[String, Unit]): Unit =
  action.left.foreach(fail)

/** The selected preset; absent means "list the available presets". */
val preset: Opts[Option[String]] = Opts.argument[String]("preset").orNone

/** The codex-switch command line. */
val switchCommand: Command[Option[String]] =
  Command("codex-switch", "Generate a Codex configuration from a preset")(preset)

/** The configuration directory: `CODEX_HOME` when set, the working directory otherwise. */
val configDir: Path = Path.of(sys.env.getOrElse("CODEX_HOME", "."))

/** Parses the command line, accepting `-h` as an alias for `--help`. */
def parseArguments(command: Command[Option[String]], arguments: Seq[String]): Either[Help, Option[String]] =
  command.parse(arguments.map(argument => if argument == "-h" then "--help" else argument), sys.env)

parseArguments(switchCommand, args.toIndexedSeq) match
  case Left(help) if help.errors.nonEmpty =>
    System.err.println(help)
    sys.exit(1)
  case Left(help) =>
    println(help)
    sys.exit(0)
  case Right(None)       => exitOnFailure(listPresets(configDir))
  case Right(Some(name)) => exitOnFailure(applyPreset(configDir, name))
