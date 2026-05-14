# Go Learning Guide — Through the Lens of This Chaincode

Everything here is explained using real examples from `agreement.go` and `main.go` in this folder.

---

## 1. Packages — the basic unit of Go code

Every `.go` file starts with a `package` declaration.

```go
package main   // this file is the program entry point
```

All files in the same folder **must** share the same package name. When you see `package main` + a `main()` function, Go compiles it as a runnable binary. Every other package is a library.

---

## 2. Imports — explicit, no unused allowed

```go
import (
    "encoding/json"           // standard library
    "fmt"                     // standard library
    "github.com/hyperledger/fabric-contract-api-go/contractapi"  // third-party
)
```

Go refuses to compile if you import something you don't use. This is enforced by the compiler, not a linter.

---

## 3. Variables — three ways to declare

```go
// 1. Full declaration (used outside functions)
var name string = "rohan"

// 2. Short declaration with := (only inside functions, most common)
id := "agreement-1"

// 3. Zero values — Go initializes everything automatically
var count int       // count == 0
var flag bool       // flag == false
var text string     // text == ""
var data []byte     // data == nil
```

---

## 4. Functions — multiple return values are idiomatic

JS returns one thing. Go returns multiple values, and by convention the **last one is always an error**.

```go
// JS equivalent: async createAgreement(ctx, agreementData) { ... }
func (c *AgreementContract) CreateAgreement(
    ctx contractapi.TransactionContextInterface,
    agreementData string,
) (string, error) {   // returns txID + error
    ...
    return ctx.GetStub().GetTxID(), nil   // nil means "no error"
}
```

Callers always check the error immediately:

```go
txID, err := c.CreateAgreement(ctx, data)
if err != nil {
    return "", err   // propagate up
}
```

You will write `if err != nil` a hundred times in Go. This is intentional — errors are values, not exceptions.

---

## 5. Structs — defining your own types

A struct is a named collection of fields. Like a class with no methods (methods come separately).

```go
type QueryRecord struct {
    Key    string      `json:"key"`     // backtick annotations = struct tags
    Record interface{} `json:"record"`  // interface{} means "any type"
}
```

The `json:"key"` part is a **struct tag** — it tells `encoding/json` what JSON field name to use when marshaling/unmarshaling.

---

## 6. Methods and Receivers — Go's version of class methods

Go doesn't have classes. Instead, you attach functions to types using a **receiver**:

```go
//         receiver (like "this" in JS)
//             ↓
func (c *AgreementContract) CreateAgreement(ctx ..., agreementData string) (string, error) {
    // c is the instance — same as "this" in JS
}
```

The `*AgreementContract` means it's a **pointer receiver** — `c` is a pointer to the struct, not a copy. Almost always use pointer receivers (`*T`) so you're working on the real object.

---

## 7. Embedding — Go's version of inheritance

```go
type AgreementContract struct {
    contractapi.Contract   // embedded — no field name, just the type
}
```

Embedding is different from inheritance. It means `AgreementContract` **includes** all fields and methods of `contractapi.Contract` directly. The framework uses this to discover your chaincode functions via reflection.

JS equivalent (rough):
```js
class Agreement extends Contract { ... }
```

---

## 8. Interfaces — implicit implementation

In Go, you don't declare that a type implements an interface. If your type has all the required methods, it automatically satisfies the interface.

```go
// This is defined in the contractapi package:
type TransactionContextInterface interface {
    GetStub() shim.ChaincodeStubInterface
    GetClientIdentity() cid.ClientIdentity
}
```

Your functions accept the interface, not the concrete type — this makes testing much easier because you can substitute a mock.

---

## 9. Pointers — the `*` and `&` symbols

```go
var x int = 5
p := &x       // & = "address of" — p is a pointer to x
fmt.Println(*p) // * = "dereference" — read the value at the pointer → 5
*p = 10       // write through the pointer — x is now 10
```

In this chaincode you see pointers in receiver types (`*AgreementContract`) and function signatures. Most of the time you don't manage memory manually — Go's garbage collector handles it.

---

## 10. Maps — dynamic key-value storage

```go
// Declaration
var m map[string]interface{}   // nil map, can't write to it yet

// Initialize
m := make(map[string]interface{})

// Or via literal
m := map[string]interface{}{
    "status": "PENDING",
    "id":     "agr-1",
}

// Read
val := m["status"]    // returns interface{}, zero value if key missing

// Write
m["createdAt"] = time.Now().UTC().Format(time.RFC3339)

// Delete
delete(m, "someKey")
```

In this chaincode `map[string]interface{}` is used to handle the agreement JSON without defining every possible field — same flexibility as a JS object.

---

## 11. Type Assertions — extracting concrete types from `interface{}`

When you put something into `interface{}`, Go forgets the original type. To use it as a string again:

```go
// agreement["id"] is interface{} — we assert it's a string
id, ok := agreement["id"].(string)
if !ok || id == "" {
    return "", fmt.Errorf("agreement must have an id field")
}
```

The two-value form `val, ok := x.(T)` is safe — if the assertion fails, `ok` is `false` and the program doesn't panic. The one-value form `val := x.(T)` panics if wrong type.

---

## 12. Slices — dynamic arrays

```go
// A slice is a view into an underlying array
var results []QueryRecord             // nil slice (length 0)
results = append(results, record)     // append returns a new slice

// Literal
names := []string{"org1", "org2"}

// Iterating
for i, name := range names {
    fmt.Println(i, name)   // i = index, name = value
}

// Ignore index with _
for _, name := range names {
    fmt.Println(name)
}
```

---

## 13. The `for` Loop — Go's only loop

Go has **one loop keyword**: `for`. It covers all cases.

```go
// while-style
for iterator.HasNext() {
    response, err := iterator.Next()
    ...
}

// classic C-style
for i := 0; i < 10; i++ { ... }

// range over slice
for _, agreement := range agreements { ... }

// infinite loop
for {
    // break when done
}
```

There is no `while`, `do-while`, or `foreach` keyword.

---

## 14. `defer` — run this when the function returns

`defer` schedules a call to run when the surrounding function exits, regardless of how it exits (normal return or error).

```go
iterator, err := ctx.GetStub().GetStateByRange("", "")
if err != nil {
    return "", err
}
defer iterator.Close()   // guaranteed to run even if we return early with an error
```

This is Go's answer to `try/finally` in JS. Multiple defers run in LIFO order (last in, first out).

---

## 15. `encoding/json` — marshaling and unmarshaling

```go
// struct/map → JSON string (Marshal)
data, err := json.Marshal(agreement)   // returns []byte
// []byte is a byte slice — you can cast it: string(data)

// JSON string → struct/map (Unmarshal)
var agreement map[string]interface{}
err := json.Unmarshal([]byte(agreementData), &agreement)
// Note the & — Unmarshal needs a pointer to write into
```

JSON field names are controlled by struct tags:
```go
type Agreement struct {
    ID        string `json:"id"`
    CreatedAt string `json:"createdAt,omitempty"`  // omitempty = skip if zero value
}
```

---

## 16. Error Wrapping with `%w`

```go
// Wrap an error with context
return "", fmt.Errorf("failed to get state: %w", err)

// The original error is preserved inside the wrapper.
// Callers can unwrap it with errors.Is() or errors.As().
```

Always wrap errors with context when propagating — it makes debugging much easier. Think of it like adding a stack trace message.

---

## 17. Constants

```go
const (
    collectionOrg1   = "Org1AgreementPrivate"
    collectionShared = "SharedAgreementTerms"
)
```

Constants are evaluated at compile time. No `:=` for constants — always use `=`. They can be grouped in a `const ()` block.

---

## 18. `fmt` package — formatted output and string building

```go
fmt.Println("hello")                          // print with newline
fmt.Printf("id: %s, count: %d\n", id, count) // formatted print
msg := fmt.Sprintf("agreement %s not found", id) // build a string
err := fmt.Errorf("failed: %w", originalErr)     // build an error
```

Common verbs: `%s` string, `%d` int, `%v` any value (default format), `%+v` struct with field names, `%T` type name, `%w` wrapped error.

---

## 19. `nil` in Go

`nil` is the zero value for pointers, slices, maps, channels, functions, and interfaces. It is **not** the same as `0` or `""`.

```go
var data []byte     // nil slice — len(data) == 0, len(nil) is valid in Go
if len(data) == 0 { // safe check for empty or nil slice
    ...
}
```

In this chaincode: `GetState` returns `([]byte, error)`. If the key doesn't exist, it returns `nil, nil` — no error, but nil data. That's why we check `len(data) == 0`.

---

## 20. Go Modules — `go.mod`

Go modules are how dependencies are managed (like `package.json` in Node.js).

```
module agreement-go           ← your module name (used in imports)

go 1.21                       ← minimum Go version

require (
    github.com/hyperledger/fabric-contract-api-go v1.2.1
    github.com/hyperledger/fabric-chaincode-go    v0.0.0-...
)
```

Commands:
```bash
go mod tidy        # add missing, remove unused dependencies (like npm install)
go mod download    # download all deps to local cache
go build .         # compile
go test ./...      # run all tests
```

The `go.sum` file is auto-generated — it's a lock file with cryptographic hashes (like `package-lock.json`).

---

## 21. JS vs Go — Side-by-Side Comparison

| Concept | JavaScript | Go |
|---|---|---|
| Async function | `async function foo() {}` | No async needed — Go is synchronous by default in chaincode |
| Error handling | `try/catch` or `.catch()` | `val, err := foo(); if err != nil` |
| Dynamic object | `const obj = {}` | `map[string]interface{}` |
| Class | `class Foo extends Bar {}` | `type Foo struct { Bar }` (embedding) |
| Class method | `async methodName(ctx, arg) {}` | `func (f *Foo) MethodName(ctx ..., arg string) (string, error)` |
| JSON parse | `JSON.parse(str)` | `json.Unmarshal([]byte(str), &target)` |
| JSON stringify | `JSON.stringify(obj)` | `json.Marshal(obj)` returns `([]byte, error)` |
| Array | `[]` | `[]T` (typed slice) |
| Null check | `if (!data \|\| data.length === 0)` | `if len(data) == 0` |
| String format | `` `agreement ${id} not found` `` | `fmt.Sprintf("agreement %s not found", id)` |
| Import | `const { Contract } = require('...')` | `import "github.com/..."` |
| Export | `module.exports = Agreement` | Exported by capitalization: `func CreateAgreement` vs `func agreementExists` |

**Key rule for exports in Go**: if a name starts with a capital letter it is exported (public). Lowercase = package-private. No `export` keyword.

---

## 22. Goroutines (Brief) — concurrency in Go

You won't use these in Fabric chaincode (the stub is not goroutine-safe), but you'll see them everywhere else in Go.

```go
// Start a goroutine — extremely lightweight thread
go func() {
    fmt.Println("running in background")
}()

// Goroutines communicate via channels
ch := make(chan string)
go func() {
    ch <- "result"   // send into channel
}()
msg := <-ch          // receive from channel (blocks until value arrives)
```

Goroutines are what makes Go excellent for servers and concurrent systems.

---

## 23. What to Read Next

1. **Tour of Go** — interactive browser-based tutorial: `https://go.dev/tour`
2. **Effective Go** — idiomatic patterns: `https://go.dev/doc/effective_go`
3. **Go by Example** — short practical examples: `https://gobyexample.com`
4. **Hyperledger Fabric Go Contract API docs** — `https://pkg.go.dev/github.com/hyperledger/fabric-contract-api-go`
