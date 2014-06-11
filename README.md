ActiveREST
==========

    The web library that makes fun of web libraries in its name,
    by calling itself a web library name that's an oxymoron

ActiveREST is the stuff in between a server API and React.

It addresses these needs:
----------------------

**1. Fetching data from server**

- Injecting it into React components
- And saving changes back to DB

**2. Caching data**

- So you can access it repeatedly in javascript data structures
  without re-fetching each time

**3. Allowing loading indicators when data is being fetched (spinners, etc)**

Everything else is left simple, and un-designed.  There's no
object-oriented model system.  No pubsub.  No dispatchers.  Those
aren't necessary.

All you need is `fetch(key)`, and `save(object)`.

How to Use it
-----------------

Here's a basic scenario. Let's render Book #34.

```javascript
	var book = fetch('/book/34')
	React.renderComponent(<Book data={book} />, document.body)
```

Look at that fetch.  It goes to the server's
`http://server.com/book/34` url, which returns nested JSON like this:

```javascript
    { key: '/book/34',
      title: 'Should I have a baby?',
      description: '...',
      sections: [{key: '/section/34',
                  page_number: 1,
                  header: 'How to choose a baby',
                  body: 'First, put on some good-looking undies...'
                  ...},
                 {...}]
    }
```

This data is cached automatically within ActiveREST, with a line like this:

```javascript
	cache[object.key] = object
```

The programmer specifies a `key` field on every JSON dictionary he
wants cached.  He can even cache nested dictionaries like
`/section/34` above.  For many objects, this `key` doubles as a
RESTful URL, and is used when we save objects, which you'll learn
soon.

  The cache is saved in `localStorage` so that it never dies.

The Book component's `render()` method can then access this data  like so:

```javascript
	this.props.title
	this.props.sections[3]
```

If the user edits the book title, we save the edits with:

```javascript
	book.title = <new title>
	save(proposal)
```

  This will save the new data on the server.  It updates the cache,
  then does a `POST/PUT/UPDATE` request to the proposal object's `key`
  url, and tells React to re-render the DOM.

To create a new object, just make one like this:

```javascript
	var booky_book = { key: new_key('book'),
	                   title: 'Barf on you, man!',
	                   ... }
```

  ...and then save it with `save()`.  This will put it in the cache and
  save it in the server.

Loading indicators
-----------
Perhaps we want to customize the HTML of a component when it's
loading.

In ActiveREST, you add a `render_loading()` method to any component
that will need a spinner.  This will automatically get called, instead
of `render()`, if the data it depends upon is still being fetched over
the internet.  When the data loads, it'll re-render with `render()`.

We can one-up the venerable `spinner.gif` with this.  We could display
proposals as outlines when loading, and fill in the text, images, and
details once they load.  Those details could be presented as "Missing
3d Cutouts" while loading.  You know, something like this:


     /\/\/\/\/\/\/\/\/\/\/\
     \                    /
     /                    \
     \                    /
     /                    \
     \/\/\/\/\/\/\/\/\/\/\/


Or this, where the # is a shadow effect:

      ____________________
     |####################|
     |#                   |
     |#                   |
     |#                   |
     |#                   |
     |#___________________|


Or a checkerboard image:


     ##  ##  ##  ##  ##  ##
       ##  ##  ##  ##  ##
     ##  ##  ##  ##  ##  ##
       ##  ##  ##  ##  ##
     ##  ##  ##  ##  ##  ##

Any component's `render_loading()` method can explicitly call their
nested child's `render_loading()` method if they wish.  To do the 3d
Cutout on a child's component, add the following line to its class:

     render_loading: render_3d_cutout,

Or if you want a spinner, use:

```javascript
    render_loading: function () { return <img src="/static/spinner.gif"> }
```

> NOTE: This `render_loading` API isn't supported yet.  Instead,
> put an `if` statement into your `render()` method that branches on
> `has_loaded(this)`, like this:
> 
```javascript
    render: function () {
        if (has_loaded(this)) {
            ... render normally ...
        } else {
            ... render loading indicator ...
        }
    }
```
> 
> I'll make the `render_loading()` method work once I implement a
> React.createClass wrapper.

Partial Data
--------------

Some pages only need parts of objects.  For instance, a book's table of
contents page needs the `header` and `page_number` of every section...

    +================================+
    |     SHOULD I HAVE A BABY?      |
    |--------------------------------|
    |                                |
    |       Table of Contents        |
    |                                |
    | How to choose a baby       p1  |
    | Who to make a baby with    p3  |
    | What clothing to wear      p10 |
    | ...                        ... |

...but it doesn't need to download each section's full `body`!  That
would take forever.  To display this page, we'll want to load a
_subset_ of every section: the headers and page numbers, but no full
text bodies.

ActiveREST lets us work with a subset of an object by appending a
`?subset` tag to the object's key.  For instance, we might invent a
`?no_body` subset name for any section that lacks a `body` and give
these objects keys like:

```javascript
   key = "/section/34?no_body"
```

Now, the server can return a condensed data structure for the table of
contents (omitting the `body` fields):

```javascript
    { key: '/table_of_contents/87',
      sections: [{key: '/section/34?no_body',
                  page_number: 1,
                  header: 'How to choose a baby'},     // Look, no body!
                 {key: '/section/43?no_body',
                  page_number: 3,
                  header: 'Who to make a baby with'},  // Look ma, no body!
                  {...}]
    }
```

Even better, ActiveREST will re-use this summary information when we
load a full section!  Full objects don't have a `?subset` section in
their key.

All subsets map to the same cache location, so the information from
one subset is automatically available in others.

Let's imagine that the user clicks on the first section, "How to
choose a baby".  This will need the full section data, and will run:

```javascript
var data = fetch("/section/34")    // Download the full section.  No subset specified!
React.renderComponent(...data...)  // Render the component (a loading indicator at first)
```

But even while the full data loads, ActiveREST will hold onto the
previous `?no_body` data, and the section's `render_loading()`
function can take advantage of it by just checking if the summary info
is in the cache, and using it if so:

```javascript
function render() {
    var header = section.header || spinner
    var page_number = section.page_number || spinner
    var body = section.body || spinner
    return <div>{{header}}</div><div>{{body}}</div><div>{{page_number}}</div>
}
```

Now, when a user goes to a section, it will immediately show the
section's `header` and `page_number` (re-using them from the
homepage), and will show the full body text once it's been downloaded.

**Tech Specs**

You can specify that multiple subsets are loaded with
`?set1&set2` syntax, such as `?summary&footer`.

When ActiveREST is loading part of an object, it marks it with
`?subset=loading`, and if the whole object is loading, then it
specifies `?loading`. (The current implementation only supports
`?loading` for the whole object because I haven't written the full
query string parsing code.)


Optimizations
------------
The first release will be simple but inefficient.  For instance:

  - Every changed datum will re-render the entire page.
  - The user must refresh their browser to get changes another user made
    - A naïve polling solution needs to repeatedly re-fetch the
      entire cache to discover what changed

However, the design allows us to solve these problems later with
black-box optimizations, that we can implement without requiring
programmers to change their code.  Here are four that we could do:

  **OPTIMIZATION 1.** When new data arrives, re-render only the components
  that depend on it.  (Instead of re-rendering the whole page.)

  **OPTIMIZATION 2.** Server keeps track of what data the browser has seen
  -- a mirror of the browser's cache -- and only sends the changed
  parts to the browser for any given request.

  **OPTIMIZATION 3.** Realtime live updates, using #2.

  **OPTIMIZATION 4.** Speculatively pre-fetch data from server before it's
  needed, keeping statistics and a simple utility measure.

I have notes on how to implement these.  Lemme know if you want em.

Specifying custom cache keys
----------

If the programmer can't change the server's API to include a "key"
field, he can give ActiveREST a pair of custom functions:

```javascript
    function cache_key_func (object) { ... return key ... }
    function save_object_url (object) { ... return url ... }
```

These simply default to:

```javascript
    cache_key_func = save_object_url = function (object) { return object.key }
```

This unification of CACHING KEYS and SAVING API METHOD within RESTful
URLs is the REST part of ActiveREST.

Custom server APIs
------------

The server is free to generate its JSON responses in any way it likes,
e.g.:

 - Joins over a relational database
 - Directly mapping it to a NoSQL json data store

Giving new objects good keys
-------------

When the client makes a new object and sends it to the server, it
generates a temp key.  For instance:

```javascript
    new_key("point")  =>  "/new/point/34"
```

The server might prefer to name its keys according to its internal
database row ids.  That's fine.  It can choose a better key for each
new object the client sends it, return that info to the client, and
the client will keep track of the old and new key, translating between
both so that the changed url is transparent to the programmer.
  
Current Status
------------

Big things:
- I've implemented `fetch()`, but haven't finished `save()`.

Littler things:
- Doesn't yet distinguish between partially-loaded and not-at-all-loaded objects
- `render_loading()` API isn't fully implemented
- Hasn't been optimized in the slightest

The Name
------------
 - ACTIVE: because it's an active DB layer like ActiveRecord
 - REST:   because the data schema is defined in terms of RESTful url keys

We call it ActiveREST because programmers fervently combine "Active"
records with "REST" in a programming religion that is full of
contradiction.  To embody this contradiction, ActiveREST is an
oxymoron.

The branding and religion of a product should not be contradictory.
Our branding, on the other hand, has deep meaning.  The meaning of
seeking meaning in branding, by illustrating a contradiction in
branding.

I think it would be awesome if programmers used ActiveREST for a while
without realizing that they are using an oxymoron, and then when they
find out, the jokes on them ignorant suckers!

    He's the one, who likes all our pretty songs
    And he likes to sing along
    And he likes to shoot his gun
    But he don't know what it means

    In Bloom, by Nirvana
    https://www.youtube.com/watch?v=6vqfuAczm7g

Maybe the code-name for ActiveREST can be "In Bloom", because that's
the name of the song that describes the people who don't know that the
code-name of ActiveREST is the meaning of the song "In Bloom".  They
deserve not to know it, them ignorant suckers!

Finally, the React portion of ActiveREST is named ReActiveREST.
